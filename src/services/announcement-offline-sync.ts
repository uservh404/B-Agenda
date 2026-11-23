import {
  hasConfirmedAccountSuspension,
  isAccountSuspensionConfirmedInSession,
  notifyConfirmedAccountSuspension,
} from "../auth/account-suspension-response";
import {
  checkOfflineSyncAccount,
  checkOfflineSyncAuthorization,
} from "./offline-sync-authorization";
import {
  applyAnnouncementOperation,
  canPublishAnnouncements,
  listAnnouncements,
} from "./announcements";
import {
  completeAnnouncementOperation,
  markAnnouncementOperationAttempted,
  readAnnouncementCache,
  requeueRejectedAnnouncementOperation,
  resetRejectedAnnouncementOperationForRetry,
  saveAnnouncementSnapshot,
  updateAnnouncementOperation,
  type AnnouncementCacheIdentity,
  type AnnouncementOperation,
} from "./announcement-offline-cache";

export interface AnnouncementSyncResult {
  serverReachable: boolean;
  dataReadConfirmed?: boolean;
  error?: string;
}

interface ActiveSync {
  requested: boolean;
  promise: Promise<AnnouncementSyncResult>;
}

const activeSyncs = new Map<string, ActiveSync>();

function operationError(code: string) {
  if (code === "not_authorized") return "Tu permiso para publicar Anuncios ya no está activo.";
  if (code === "version_conflict") return "El anuncio cambió en otra sesión. Revisa la versión del servidor.";
  if (code === "announcement_not_active") return "El anuncio ya no está activo.";
  if (code === "announcement_id_exists") return "El identificador del anuncio ya está en uso.";
  if (code === "operation_id_reused") return "La operación tiene un identificador repetido y necesita revisión.";
  if (code === "invalid_announcement_payload") return "Los datos pendientes del anuncio no son válidos.";
  if (code === "author_attribution_unavailable") return "No se pudo conservar el nombre del autor. Completa tu perfil antes de publicar.";
  return "El servidor no pudo aplicar el cambio. Revisa el anuncio antes de continuar.";
}

function announcementAuthorization(userId: string) {
  return checkOfflineSyncAuthorization(
    userId,
    () => canPublishAnnouncements(userId),
  );
}

interface AnnouncementPreflight {
  blockedAnnouncementIds: Set<string>;
  conflictedOperations: Map<string, string>;
  retryableOperations: Set<string>;
  rekeyOperations: Set<string>;
  stopAfterOperationIds: Set<string>;
}

function preflightAnnouncementOperations(
  operations: AnnouncementOperation[],
  serverAnnouncements: Awaited<ReturnType<typeof listAnnouncements>>,
): AnnouncementPreflight {
  const serverVersions = new Map(serverAnnouncements.map((announcement) => [
    announcement.id,
    announcement.version,
  ]));
  const blockedAnnouncementIds = new Set<string>();
  const conflictedOperations = new Map<string, string>();
  const retryableOperations = new Set<string>();
  const rekeyOperations = new Set<string>();
  const stopAfterOperationIds = new Set<string>();

  for (const operation of operations) {
    const announcementId = operation.announcementId;
    if (blockedAnnouncementIds.has(announcementId)) continue;

    const retryableRejection = operation.status === "rejected"
      && operation.code === "not_authorized";
    if (operation.status !== "pending" && !retryableRejection) {
      blockedAnnouncementIds.add(announcementId);
      continue;
    }

    const version = serverVersions.get(announcementId);
    const idempotentRetry = operation.attempts > 0;
    let conflictCode: string | null = null;
    let nextVersion = version;

    if (operation.kind === "create") {
      if (operation.expectedVersion !== 0) {
        conflictCode = "version_conflict";
      } else if (version === undefined) {
        nextVersion = 1;
      } else if (idempotentRetry) {
        nextVersion = version;
        if (version !== 1) stopAfterOperationIds.add(operation.operationId);
      } else {
        conflictCode = "announcement_id_exists";
      }
    } else if (version === operation.expectedVersion) {
      nextVersion = operation.kind === "delete"
        ? undefined
        : version + 1;
    } else if (idempotentRetry) {
      nextVersion = version;
      if (
        version !== operation.expectedVersion + 1
        && !(version === undefined && operation.kind === "delete")
      ) {
        stopAfterOperationIds.add(operation.operationId);
      } else if (operation.kind === "delete" && version !== undefined) {
        stopAfterOperationIds.add(operation.operationId);
      }
    } else {
      conflictCode = version === undefined
        ? "announcement_not_active"
        : "version_conflict";
    }

    if (conflictCode) {
      conflictedOperations.set(operation.operationId, conflictCode);
      blockedAnnouncementIds.add(announcementId);
      continue;
    }

    if (retryableRejection) {
      if (operation.authorizationRejected === true) {
        rekeyOperations.add(operation.operationId);
      } else {
        retryableOperations.add(operation.operationId);
      }
    }
    if (nextVersion === undefined) serverVersions.delete(announcementId);
    else serverVersions.set(announcementId, nextVersion);
  }

  return {
    blockedAnnouncementIds,
    conflictedOperations,
    retryableOperations,
    rekeyOperations,
    stopAfterOperationIds,
  };
}

async function recordUnauthorizedAnnouncementOperations(
  identity: AnnouncementCacheIdentity,
  operations: AnnouncementOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.status !== "pending") continue;
    await updateAnnouncementOperation(identity, operation.operationId, {
      status: operation.attempts === 0 ? "rejected" : "pending",
      code: "not_authorized",
      lastError: operationError("not_authorized"),
      authorizationRejected: false,
    });
  }
}

async function runSync(identity: AnnouncementCacheIdentity): Promise<AnnouncementSyncResult> {
  if (!window.navigator.onLine) return { serverReachable: false, error: "Sin conexión." };
  let dataReadConfirmed = false;
  try {
    isAccountSuspensionConfirmedInSession(identity.userId);
    const account = await checkOfflineSyncAccount(identity.userId);
    if (account.status === "suspended") {
      return { serverReachable: true, error: "La cuenta está suspendida." };
    }
    if (account.status === "unavailable") {
      return {
        serverReachable: false,
        error: "No se pudo confirmar el estado ni la sesión de la cuenta. Los cambios quedaron guardados.",
      };
    }
    if (account.status === "forbidden") {
      return { serverReachable: true, error: "La cuenta no tiene acceso a los Anuncios." };
    }

    const announcements = await listAnnouncements(identity.userId);
    if (isAccountSuspensionConfirmedInSession(identity.userId)) {
      return { serverReachable: true, error: "La cuenta está suspendida." };
    }
    const readAt = new Date().toISOString();
    let canPublish: boolean | null = null;
    let permissionError: string | null = null;
    try {
      canPublish = await canPublishAnnouncements(identity.userId);
    } catch (error) {
      if (hasConfirmedAccountSuspension(error)) {
        notifyConfirmedAccountSuspension(identity.userId);
        return { serverReachable: true, error: "La cuenta está suspendida." };
      }
      permissionError = error instanceof Error
        ? error.message
        : "No se pudo verificar el permiso de publicación.";
    }
    if (isAccountSuspensionConfirmedInSession(identity.userId)) {
      return { serverReachable: true, error: "La cuenta está suspendida." };
    }
    await saveAnnouncementSnapshot(
      identity,
      announcements,
      readAt,
      canPublish ?? undefined,
    );
    dataReadConfirmed = true;
    const { operations } = await readAnnouncementCache(identity);
    if (canPublish === false) {
      await recordUnauthorizedAnnouncementOperations(identity, operations);
      return {
        serverReachable: true,
        dataReadConfirmed,
        error: operationError("not_authorized"),
      };
    }
    if (canPublish === null) {
      return {
        serverReachable: true,
        dataReadConfirmed,
        error: `No se enviaron operaciones porque no se pudo verificar el permiso de publicación${permissionError ? `: ${permissionError}` : "."}`,
      };
    }

    const preflight = preflightAnnouncementOperations(operations, announcements);
    for (const [operationId, code] of preflight.conflictedOperations) {
      await updateAnnouncementOperation(identity, operationId, {
        status: "conflict",
        code,
        lastError: operationError(code),
        authorizationRejected: false,
      });
    }
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (preflight.blockedAnnouncementIds.has(operation.announcementId)) continue;
      if (preflight.rekeyOperations.has(operation.operationId)) {
        operations[index] = await requeueRejectedAnnouncementOperation(
          identity,
          operation.operationId,
        );
      } else if (preflight.retryableOperations.has(operation.operationId)) {
        await resetRejectedAnnouncementOperationForRetry(identity, operation.operationId);
        operation.status = "pending";
        operation.code = undefined;
        operation.lastError = undefined;
        operation.authorizationRejected = false;
      }
    }

    const blockedAnnouncements = preflight.blockedAnnouncementIds;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (blockedAnnouncements.has(operation.announcementId)) continue;
      if (operation.status !== "pending") {
        blockedAnnouncements.add(operation.announcementId);
        continue;
      }
      if (!window.navigator.onLine) {
        return {
          serverReachable: false,
          dataReadConfirmed,
          error: "La conexión se perdió durante la sincronización. Los cambios se conservaron.",
        };
      }
      if (isAccountSuspensionConfirmedInSession(identity.userId)) {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }

      const operationAuthorization = await announcementAuthorization(identity.userId);
      if (operationAuthorization.status === "suspended") {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }
      if (operationAuthorization.status === "unavailable") {
        return {
          serverReachable: false,
          dataReadConfirmed,
          error: "No se pudieron revalidar el estado y los permisos antes de sincronizar. Los cambios se conservaron.",
        };
      }
      if (operationAuthorization.status === "forbidden") {
        await recordUnauthorizedAnnouncementOperations(identity, operations.slice(index));
        return { serverReachable: true, dataReadConfirmed, error: operationError("not_authorized") };
      }
      if (isAccountSuspensionConfirmedInSession(identity.userId)) {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }

      try {
        const attemptedOperation = await markAnnouncementOperationAttempted(identity, operation.operationId);
        if (!attemptedOperation) {
          blockedAnnouncements.add(operation.announcementId);
          continue;
        }
        operations[index] = attemptedOperation;
        const result = await applyAnnouncementOperation({
          operationId: attemptedOperation.operationId,
          kind: attemptedOperation.kind,
          announcementId: attemptedOperation.announcementId,
          expectedVersion: attemptedOperation.expectedVersion,
          input: attemptedOperation.input,
        }, identity.userId);
        if (result.status === "confirmed") {
          let rebased: AnnouncementOperation | null;
          try {
            rebased = await completeAnnouncementOperation(
              identity,
              attemptedOperation.operationId,
              result.version,
            );
          } catch (error) {
            return {
              serverReachable: true,
              dataReadConfirmed,
              error: error instanceof Error
                ? `Supabase confirmó el cambio, pero no se pudo actualizar la cola local: ${error.message}. Se conservará el mismo identificador para evitar duplicados.`
                : "Supabase confirmó el cambio, pero no se pudo actualizar la cola local. Se conservará el mismo identificador para evitar duplicados.",
            };
          }
          if (rebased) {
            const successorIndex = operations.findIndex((queued) => queued.operationId === rebased.operationId);
            if (successorIndex >= 0) operations[successorIndex] = rebased;
          }
          if (preflight.stopAfterOperationIds.has(operation.operationId)) {
            blockedAnnouncements.add(operation.announcementId);
          }
          continue;
        }
        await updateAnnouncementOperation(identity, operation.operationId, {
          status: result.status,
          code: result.code,
          lastError: operationError(result.code),
          authorizationRejected: result.code === "not_authorized",
        });
        if (result.code === "not_authorized") {
          operation.status = "rejected";
          operation.authorizationRejected = true;
          await recordUnauthorizedAnnouncementOperations(identity, operations.slice(index + 1));
          return { serverReachable: true, dataReadConfirmed, error: operationError("not_authorized") };
        }
        blockedAnnouncements.add(operation.announcementId);
      } catch (error) {
        if (hasConfirmedAccountSuspension(error)) {
          notifyConfirmedAccountSuspension(identity.userId);
          return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
        }
        if (!window.navigator.onLine) {
          return {
            serverReachable: false,
            dataReadConfirmed,
            error: "La conexión se perdió durante la sincronización. Los cambios se conservaron.",
          };
        }
        return {
          serverReachable: true,
          dataReadConfirmed,
          error: error instanceof Error
            ? `No se pudo confirmar una operación de Anuncios: ${error.message}`
            : "No se pudo confirmar una operación de Anuncios.",
        };
      }
    }
    const [refreshedAnnouncements, refreshedCanPublish] = await Promise.all([
      listAnnouncements(identity.userId),
      canPublishAnnouncements(identity.userId),
    ]);
    if (isAccountSuspensionConfirmedInSession(identity.userId)) {
      return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
    }
    const remaining = (await readAnnouncementCache(identity)).operations;
    await saveAnnouncementSnapshot(
      identity,
      refreshedAnnouncements,
      new Date().toISOString(),
      refreshedCanPublish,
    );
    dataReadConfirmed = true;
    if (!refreshedCanPublish) {
      await recordUnauthorizedAnnouncementOperations(identity, remaining);
      return {
        serverReachable: true,
        dataReadConfirmed,
        error: operationError("not_authorized"),
      };
    }
    if (remaining.some((operation) => operation.status !== "pending")) {
      return {
        serverReachable: true,
        dataReadConfirmed,
        error: "Hay cambios de Anuncios que requieren revisión.",
      };
    }
    return { serverReachable: true, dataReadConfirmed };
  } catch (error) {
    if (hasConfirmedAccountSuspension(error)) {
      notifyConfirmedAccountSuspension(identity.userId);
      return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
    }
    return {
      serverReachable: false,
      dataReadConfirmed,
      error: error instanceof Error
        ? `No se pudo actualizar Anuncios: ${error.message}`
        : "No se pudo actualizar Anuncios. Los cambios locales se conservaron.",
    };
  }
}

export function synchronizeAnnouncements(
  identity: AnnouncementCacheIdentity,
): Promise<AnnouncementSyncResult> {
  const active = activeSyncs.get(identity.scope);
  if (active) {
    active.requested = true;
    return active.promise;
  }
  const state: ActiveSync = {
    requested: false,
    promise: Promise.resolve({ serverReachable: false }),
  };
  activeSyncs.set(identity.scope, state);
  state.promise = (async () => {
    let result: AnnouncementSyncResult;
    do {
      state.requested = false;
      result = await runSync(identity);
    } while (state.requested && window.navigator.onLine && !result.error);
    return result;
  })();
  return state.promise.finally(() => {
    if (activeSyncs.get(identity.scope) === state) activeSyncs.delete(identity.scope);
  });
}
