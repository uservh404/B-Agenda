import { supabase } from "../lib/supabaseClient";
import {
  applyResourceOperation,
  listResources,
  type ResourceItem,
} from "./resources";
import {
  completeResourceOperation,
  markResourceOperationError,
  markResourceOperationProblem,
  readResourceCache,
  saveResourceSnapshot,
  type ResourceCacheIdentity,
} from "./resource-offline-cache";

export interface ResourceSyncResult {
  serverReachable: boolean;
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

async function runResourceSync(
  identity: ResourceCacheIdentity,
): Promise<ResourceSyncResult> {
  if (!window.navigator.onLine) {
    return { serverReachable: false, error: "No hay conexión a Internet." };
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || data.session?.user.id !== identity.userId) {
      return {
        serverReachable: false,
        error: "La sesión actual no corresponde a la cuenta de los cambios guardados.",
      };
    }

    let serverResources: ResourceItem[];
    const initialFetchAt = new Date().toISOString();
    try {
      serverResources = await listResources(identity.userId);
    } catch {
      const connectionDropped = !window.navigator.onLine;
      const { data: currentSession, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || currentSession.session?.user.id !== identity.userId) {
        return {
          serverReachable: false,
          error: "La sesión cambió. Los cambios se conservaron para la cuenta original.",
        };
      }
      const { operations } = await readResourceCache(identity);
      for (const operation of operations) {
        if (operation.status === "pending") {
          if (connectionDropped) {
            await markResourceOperationError(
              identity,
              operation.operationId,
              "La conexión se perdió antes de iniciar la sincronización.",
            );
          } else {
            await markResourceOperationProblem(
              identity,
              operation.operationId,
              "rejected",
              "sync_error",
              operationProblemMessage("sync_error"),
            );
          }
        }
      }
      return {
        serverReachable: false,
        error: connectionDropped
          ? "La conexión se perdió antes de iniciar la sincronización. Los cambios se reintentarán al reconectarse."
          : "No se pudo contactar con el servidor. Los cambios quedaron guardados para revisión.",
      };
    }
    await saveResourceSnapshot(identity, serverResources, initialFetchAt);
    const { operations } = await readResourceCache(identity);
    const blockedResourceIds = new Set<string>();

    for (const operation of operations) {
      if (operation.status !== "pending") {
        blockedResourceIds.add(operation.resourceId);
        continue;
      }
      if (blockedResourceIds.has(operation.resourceId)) {
        continue;
      }
      if (!window.navigator.onLine) {
        return { serverReachable: true, error: "La conexión se perdió durante la sincronización." };
      }

      let result;
      let confirmedResource: ResourceItem | null = null;
      let removeWhenNoConfirmedResource = operation.kind === "delete";
      try {
        result = await applyResourceOperation({
          operationId: operation.operationId,
          kind: operation.kind,
          resourceId: operation.resourceId,
          expectedVersion: operation.expectedVersion,
          input: operation.input,
        }, identity.userId);
        if (result.status === "confirmed") {
          confirmedResource = result.resource;
          if (operation.kind !== "delete" && !confirmedResource) {
            const fetchedAt = new Date().toISOString();
            const currentResources = await listResources(identity.userId);
            await saveResourceSnapshot(identity, currentResources, fetchedAt);
            confirmedResource = currentResources.find((resource) =>
              resource.id === operation.resourceId,
            ) ?? null;
            removeWhenNoConfirmedResource = confirmedResource === null;
          }
        }
      } catch {
        if (!window.navigator.onLine) {
          await markResourceOperationError(
            identity,
            operation.operationId,
            "La conexión se perdió antes de confirmar el cambio.",
          );
          return {
            serverReachable: true,
            error: "La conexión se perdió durante la sincronización. Los cambios se conservaron.",
          };
        }
        const { data: currentSession } = await supabase.auth.getSession();
        if (currentSession.session?.user.id !== identity.userId) {
          return {
            serverReachable: false,
            error: "La sesión cambió. Los cambios se conservaron para la cuenta original.",
          };
        }
        await markResourceOperationProblem(
          identity,
          operation.operationId,
          "rejected",
          "sync_error",
          operationProblemMessage("sync_error"),
        );
        return {
          serverReachable: true,
          error: "Un cambio no se pudo confirmar y quedó marcado para revisión.",
        };
      }

      if (result.status === "confirmed") {
        await completeResourceOperation(
          identity,
          operation.operationId,
          confirmedResource,
          removeWhenNoConfirmedResource,
        );
        continue;
      }

      if (
        operation.kind === "delete"
        && result.status === "conflict"
        && result.code === "resource_not_active"
      ) {
        await completeResourceOperation(identity, operation.operationId, null, true);
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
      blockedResourceIds.add(operation.resourceId);
    }

    const finalFetchAt = new Date().toISOString();
    const refreshedResources: ResourceItem[] = await listResources(identity.userId);
    await saveResourceSnapshot(identity, refreshedResources, finalFetchAt);
    return { serverReachable: true };
  } catch {
    return {
      serverReachable: false,
      error: "No se pudo contactar con el servidor. Los cambios locales se conservaron.",
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
