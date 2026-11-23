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
  getResourceManagementPermission,
  applyResourceOperation,
  listResources,
  type ResourceItem,
} from "./resources";
import {
  completeResourceOperation,
  markResourceOperationError,
  markResourceOperationProblem,
  readResourceCache,
  resetRejectedResourceOperationForRetry,
  saveResourceSnapshot,
  type ResourceCacheIdentity,
  type ResourceOutboxOperation,
} from "./resource-offline-cache";

export interface ResourceSyncResult {
  serverReachable: boolean;
  dataReadConfirmed?: boolean;
  error?: string;
}

interface SyncRunState {
  requested: boolean;
  promise: Promise<ResourceSyncResult>;
}

const activeSyncs = new Map<string, SyncRunState>();

function operationProblemMessage(code: string): string {
  if (code === "not_authorized") {
    return "Tu permiso para administrar Recursos ya no está activo.";
  }
  if (code === "version_conflict") {
    return "El recurso cambió en otra sesión. Revisa la versión del servidor antes de continuar.";
  }
  if (code === "resource_not_active") {
    return "El recurso ya no está activo en el inventario.";
  }
  if (code === "resource_id_exists") {
    return "No se pudo crear el recurso porque su identificador ya existe.";
  }
  if (code === "operation_id_reused") {
    return "La operación tiene un identificador repetido y necesita revisión.";
  }
  if (code === "invalid_resource_payload") {
    return "Los datos pendientes del recurso no son válidos.";
  }
  if (code === "sync_error") {
    return "No se pudo contactar con el servidor para confirmar este cambio.";
  }
  return "El servidor no pudo aplicar el cambio. Revisa el inventario antes de continuar.";
}

function resourceAuthorization(userId: string) {
  return checkOfflineSyncAuthorization(
    userId,
    () => getResourceManagementPermission(userId),
  );
}

interface ResourcePreflight {
  blockedResourceIds: Set<string>;
  conflictedOperations: Map<string, string>;
  retryableOperations: Set<string>;
  alreadyInactiveDeletes: Set<string>;
  stopAfterOperationIds: Set<string>;
}

function preflightResourceOperations(
  operations: ResourceOutboxOperation[],
  serverResources: ResourceItem[],
): ResourcePreflight {
  const serverState = new Map(serverResources.map((resource) => [
    resource.id,
    resource.version,
  ]));
  const blockedResourceIds = new Set<string>();
  const conflictedOperations = new Map<string, string>();
  const retryableOperations = new Set<string>();
  const alreadyInactiveDeletes = new Set<string>();
  const stopAfterOperationIds = new Set<string>();

  for (const operation of operations) {
    const resourceId = operation.resourceId;
    if (blockedResourceIds.has(resourceId)) continue;

    const retryableRejection = operation.status === "rejected"
      && (operation.code === "not_authorized" || operation.code === "sync_error");
    const idempotentRetry = operation.attempts > 0
      || (operation.status === "rejected" && operation.code === "sync_error");
    if (operation.status !== "pending" && !retryableRejection) {
      blockedResourceIds.add(resourceId);
      continue;
    }

    const version = serverState.get(resourceId);
    if (operation.kind === "delete" && version === undefined && !idempotentRetry) {
      alreadyInactiveDeletes.add(operation.operationId);
      blockedResourceIds.add(resourceId);
      continue;
    }

    let conflictCode: string | null = null;
    let confirmedVersion = version;

    if (operation.kind === "create") {
      if (operation.expectedVersion !== 0) {
        conflictCode = "version_conflict";
      } else if (version === undefined) {
        confirmedVersion = 1;
      } else if (idempotentRetry) {
        confirmedVersion = version;
        if (version !== 1) stopAfterOperationIds.add(operation.operationId);
      } else {
        conflictCode = "resource_id_exists";
      }
    } else if (version === operation.expectedVersion) {
      confirmedVersion = operation.kind === "delete"
        ? undefined
        : version + 1;
    } else if (idempotentRetry) {
      confirmedVersion = version;
      if (
        version !== operation.expectedVersion + 1
        || operation.kind === "delete"
      ) {
        stopAfterOperationIds.add(operation.operationId);
      }
    } else {
      conflictCode = version === undefined
        ? "resource_not_active"
        : "version_conflict";
    }

    if (conflictCode) {
      conflictedOperations.set(operation.operationId, conflictCode);
      blockedResourceIds.add(resourceId);
      continue;
    }

    if (retryableRejection) retryableOperations.add(operation.operationId);
    if (confirmedVersion === undefined) serverState.delete(resourceId);
    else serverState.set(resourceId, confirmedVersion);
  }

  return {
    blockedResourceIds,
    conflictedOperations,
    retryableOperations,
    alreadyInactiveDeletes,
    stopAfterOperationIds,
  };
}

async function rejectPendingResourceOperations(
  identity: ResourceCacheIdentity,
  operations: ResourceOutboxOperation[],
  message = operationProblemMessage("not_authorized"),
): Promise<void> {
  for (const operation of operations) {
    if (operation.status === "pending") {
      await markResourceOperationProblem(
        identity,
        operation.operationId,
        "rejected",
        "not_authorized",
        message,
      );
    }
  }
}

async function runResourceSync(
  identity: ResourceCacheIdentity,
): Promise<ResourceSyncResult> {
  let dataReadConfirmed = false;
  if (!window.navigator.onLine) {
    return { serverReachable: false, error: "No hay conexión a Internet." };
  }

  try {
    isAccountSuspensionConfirmedInSession(identity.userId);
    const readAccount = await checkOfflineSyncAccount(identity.userId);
    if (readAccount.status === "suspended") {
      return { serverReachable: true, error: "La cuenta está suspendida." };
    }
    if (readAccount.status === "unavailable") {
      return {
        serverReachable: false,
        error: "No se pudo confirmar el estado, la sesión y los permisos de la cuenta. Los cambios quedaron guardados.",
      };
    }
    if (readAccount.status === "forbidden") {
      return {
        serverReachable: true,
        error: "La cuenta no tiene acceso al inventario de Recursos.",
      };
    }

    let serverResources: ResourceItem[];
    const initialFetchAt = new Date().toISOString();
    try {
      serverResources = await listResources(identity.userId);
    } catch (error) {
      if (hasConfirmedAccountSuspension(error)) {
        notifyConfirmedAccountSuspension(identity.userId);
        return { serverReachable: true, error: "La cuenta está suspendida." };
      }
      const currentAccount = await checkOfflineSyncAccount(identity.userId);
      if (currentAccount.status === "suspended") {
        return { serverReachable: true, error: "La cuenta está suspendida." };
      }
      if (currentAccount.status === "forbidden") {
        return {
          serverReachable: true,
          error: "La cuenta no tiene acceso al inventario de Recursos.",
        };
      }
      if (currentAccount.status === "unavailable") {
        return {
          serverReachable: false,
          error: "No se pudo confirmar el estado de la cuenta después del error del servidor. La copia local y los cambios se conservaron.",
        };
      }
      const connectionDropped = !window.navigator.onLine;
      return {
        serverReachable: false,
        error: connectionDropped
          ? "La conexión se perdió antes de iniciar la sincronización. Los cambios se reintentarán al reconectarse."
          : "No se pudo contactar con el servidor. Los cambios locales se conservaron.",
      };
    }
    await saveResourceSnapshot(identity, serverResources, initialFetchAt);
    dataReadConfirmed = true;
    const { operations } = await readResourceCache(identity);
    const preflight = preflightResourceOperations(operations, serverResources);
    for (const [operationId, code] of preflight.conflictedOperations) {
      await markResourceOperationProblem(
        identity,
        operationId,
        "conflict",
        code,
        operationProblemMessage(code),
      );
    }
    for (const operationId of preflight.alreadyInactiveDeletes) {
      await completeResourceOperation(identity, operationId, null, true);
    }
    for (const operation of operations) {
      if (
        preflight.retryableOperations.has(operation.operationId)
        && !preflight.blockedResourceIds.has(operation.resourceId)
      ) {
        await resetRejectedResourceOperationForRetry(identity, operation.operationId);
        operation.status = "pending";
        operation.code = undefined;
        operation.lastError = undefined;
      }
    }

    const blockedResourceIds = preflight.blockedResourceIds;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (blockedResourceIds.has(operation.resourceId)) continue;
      if (operation.status !== "pending") {
        blockedResourceIds.add(operation.resourceId);
        continue;
      }
      if (!window.navigator.onLine) {
        return {
          serverReachable: true,
          dataReadConfirmed,
          error: "La conexión se perdió durante la sincronización.",
        };
      }
      if (isAccountSuspensionConfirmedInSession(identity.userId)) {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }

      const operationAuthorization = await resourceAuthorization(identity.userId);
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
        await rejectPendingResourceOperations(identity, operations.slice(index));
        return {
          serverReachable: true,
          dataReadConfirmed,
          error: operationProblemMessage("not_authorized"),
        };
      }
      if (isAccountSuspensionConfirmedInSession(identity.userId)) {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }

      let result;
      try {
        result = await applyResourceOperation({
          operationId: operation.operationId,
          kind: operation.kind,
          resourceId: operation.resourceId,
          expectedVersion: operation.expectedVersion,
          input: operation.input,
        }, identity.userId);
      } catch (error) {
        if (hasConfirmedAccountSuspension(error)) {
          notifyConfirmedAccountSuspension(identity.userId);
          return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
        }
        await markResourceOperationError(
          identity,
          operation.operationId,
          !window.navigator.onLine
            ? "La conexión se perdió antes de confirmar el cambio."
            : "No se pudo confirmar si el servidor aplicó el cambio. Se conservará el mismo identificador para un reintento idempotente.",
        );
        return {
          serverReachable: window.navigator.onLine,
          dataReadConfirmed,
          error: window.navigator.onLine
            ? "No se pudo confirmar el cambio. Se reintentará conservando el identificador de operación."
            : "La conexión se perdió durante la sincronización. Los cambios se conservaron.",
        };
      }

      if (result.status === "confirmed") {
        const confirmedResource = result.resource
          ?? (operation.kind === "delete" || !operation.optimisticResource
            ? null
            : { ...operation.optimisticResource, version: result.version });
        try {
          await completeResourceOperation(
            identity,
            operation.operationId,
            confirmedResource,
            operation.kind === "delete",
          );
        } catch (error) {
          return {
            serverReachable: true,
            dataReadConfirmed,
            error: error instanceof Error
              ? `Supabase confirmó el cambio, pero no se pudo actualizar la cola local: ${error.message}. Se conservará el mismo identificador para confirmar el resultado sin duplicarlo.`
              : "Supabase confirmó el cambio, pero no se pudo actualizar la cola local. Se conservará el mismo identificador para confirmar el resultado sin duplicarlo.",
          };
        }
        if (preflight.stopAfterOperationIds.has(operation.operationId)) {
          blockedResourceIds.add(operation.resourceId);
        }
        continue;
      }

      if (
        operation.kind === "delete"
        && result.status === "conflict"
        && result.code === "resource_not_active"
      ) {
        await completeResourceOperation(identity, operation.operationId, null, true);
        blockedResourceIds.add(operation.resourceId);
        continue;
      }

      const message = operationProblemMessage(result.code);
      await markResourceOperationProblem(
        identity,
        operation.operationId,
        result.status,
        result.code,
        message,
      );
      if (result.code === "not_authorized") {
        const currentAuthorization = await resourceAuthorization(identity.userId);
        if (currentAuthorization.status === "suspended") {
          return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
        }
        if (currentAuthorization.status === "forbidden") {
          await rejectPendingResourceOperations(identity, operations.slice(index + 1));
        } else {
          await rejectPendingResourceOperations(identity, operations.slice(index + 1));
        }
        return {
          serverReachable: true,
          dataReadConfirmed,
          error: operationProblemMessage("not_authorized"),
        };
      }
      blockedResourceIds.add(operation.resourceId);
    }

    const finalAccount = await checkOfflineSyncAccount(identity.userId);
    if (finalAccount.status === "suspended") {
      return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
    }
    if (finalAccount.status === "unavailable") {
      return {
        serverReachable: false,
        dataReadConfirmed,
        error: "No se pudo revalidar el estado de la cuenta antes de actualizar la copia local. Los cambios se conservaron.",
      };
    }
    if (finalAccount.status === "forbidden") {
      return {
        serverReachable: true,
        dataReadConfirmed,
        error: "La cuenta no tiene acceso al inventario de Recursos.",
      };
    }

    const finalFetchAt = new Date().toISOString();
    let refreshedResources: ResourceItem[];
    try {
      refreshedResources = await listResources(identity.userId);
    } catch (error) {
      if (hasConfirmedAccountSuspension(error)) {
        notifyConfirmedAccountSuspension(identity.userId);
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }
      const currentAccount = await checkOfflineSyncAccount(identity.userId);
      if (currentAccount.status === "suspended") {
        return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
      }
      if (currentAccount.status === "forbidden") {
        return {
          serverReachable: true,
          dataReadConfirmed,
          error: "La cuenta no tiene acceso al inventario de Recursos.",
        };
      }
      if (currentAccount.status === "unavailable") {
        return {
          serverReachable: false,
          dataReadConfirmed,
          error: "No se pudo confirmar el estado de la cuenta después del error del servidor. La copia local y los cambios se conservaron.",
        };
      }
      return {
        serverReachable: false,
        dataReadConfirmed,
        error: "No se pudo actualizar la copia de Recursos. La copia local y los cambios se conservaron.",
      };
    }
    await saveResourceSnapshot(identity, refreshedResources, finalFetchAt);
    return { serverReachable: true, dataReadConfirmed: true };
  } catch (error) {
    if (hasConfirmedAccountSuspension(error)) {
      notifyConfirmedAccountSuspension(identity.userId);
      return { serverReachable: true, dataReadConfirmed, error: "La cuenta está suspendida." };
    }
    return {
      serverReachable: false,
      dataReadConfirmed,
      error: "No se pudo completar la sincronización. Los cambios locales se conservaron.",
    };
  }
}

export function synchronizeResources(
  identity: ResourceCacheIdentity,
): Promise<ResourceSyncResult> {
  const active = activeSyncs.get(identity.scope);
  if (active) {
    active.requested = true;
    return active.promise;
  }

  const state: SyncRunState = {
    requested: false,
    promise: Promise.resolve({ serverReachable: false }),
  };
  activeSyncs.set(identity.scope, state);
  state.promise = (async () => {
    let result: ResourceSyncResult;
    do {
      state.requested = false;
      result = await runResourceSync(identity);
    } while (state.requested && window.navigator.onLine && !result.error);
    return result;
  })();

  return state.promise.finally(() => {
    if (activeSyncs.get(identity.scope) === state) {
      activeSyncs.delete(identity.scope);
    }
  });
}
