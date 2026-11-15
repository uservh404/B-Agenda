import {
  applyAnnouncementOperation,
  canPublishAnnouncements,
  listAnnouncements,
} from "./announcements";
import {
  completeAnnouncementOperation,
  markAnnouncementOperationAttempted,
  readAnnouncementCache,
  saveAnnouncementSnapshot,
  updateAnnouncementOperation,
  type AnnouncementCacheIdentity,
} from "./announcement-offline-cache";

export interface AnnouncementSyncResult {
  serverReachable: boolean;
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

async function runSync(identity: AnnouncementCacheIdentity): Promise<AnnouncementSyncResult> {
  if (!window.navigator.onLine) return { serverReachable: false, error: "Sin conexión." };
  try {
    const previousCache = await readAnnouncementCache(identity);
    let [announcements, canPublish] = await Promise.all([
      listAnnouncements(identity.userId),
      canPublishAnnouncements(identity.userId),
    ]);
    await saveAnnouncementSnapshot(identity, announcements, previousCache.savedAt, canPublish);
    const { operations } = await readAnnouncementCache(identity);
    const blockedAnnouncements = new Set<string>();
    for (const operation of operations) {
      if (operation.status !== "pending") continue;
      if (blockedAnnouncements.has(operation.announcementId)) continue;
      if (!window.navigator.onLine) return { serverReachable: true, error: "La conexión se perdió durante la sincronización." };
      try {
        const attemptedOperation = await markAnnouncementOperationAttempted(identity, operation.operationId);
        if (!attemptedOperation) continue;
        const result = await applyAnnouncementOperation({
          operationId: attemptedOperation.operationId,
          kind: attemptedOperation.kind,
          announcementId: attemptedOperation.announcementId,
          expectedVersion: attemptedOperation.expectedVersion,
          input: attemptedOperation.input,
        }, identity.userId);
        if (result.status === "confirmed") {
          const rebased = await completeAnnouncementOperation(
            identity,
            attemptedOperation.operationId,
            result.version,
          );
          if (rebased) {
            const successorIndex = operations.findIndex((queued) => queued.operationId === rebased.operationId);
            if (successorIndex >= 0) operations[successorIndex] = rebased;
          }
          continue;
        }
        await updateAnnouncementOperation(identity, operation.operationId, {
          status: result.status,
          code: result.code,
          lastError: operationError(result.code),
        });
        blockedAnnouncements.add(operation.announcementId);
      } catch (error) {
        if (!window.navigator.onLine) {
          return { serverReachable: false, error: "La conexión se perdió durante la sincronización. Los cambios se conservaron." };
        }
        return {
          serverReachable: true,
          error: error instanceof Error
            ? `No se pudo confirmar una operación de Anuncios: ${error.message}`
            : "No se pudo confirmar una operación de Anuncios.",
        };
      }
    }
    [announcements, canPublish] = await Promise.all([
      listAnnouncements(identity.userId),
      canPublishAnnouncements(identity.userId),
    ]);
    const remaining = (await readAnnouncementCache(identity)).operations;
    await saveAnnouncementSnapshot(
      identity,
      announcements,
      remaining.length === 0 ? new Date().toISOString() : previousCache.savedAt,
      canPublish,
    );
    if (remaining.some((operation) => operation.status !== "pending")) {
      return { serverReachable: true, error: "Hay cambios de Anuncios que requieren revisión." };
    }
    return { serverReachable: true };
  } catch (error) {
    return {
      serverReachable: false,
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
