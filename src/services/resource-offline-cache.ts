import type { ResourceInput, ResourceItem } from "./resources";

const DATABASE_NAME = "agenda-juventud-resource-cache";
const DATABASE_VERSION = 1;
const SNAPSHOTS_STORE = "snapshots";
const OPERATIONS_STORE = "operations";
const METADATA_STORE = "metadata";

export interface ResourceCacheIdentity {
  projectId: string;
  userId: string;
  scope: string;
}

export type ResourceOperationKind = "create" | "update" | "delete";
export type ResourceOperationStatus = "pending" | "conflict" | "rejected";

export interface ResourceOperationDraft {
  operationId: string;
  resourceId: string;
  kind: ResourceOperationKind;
  expectedVersion: number;
  input?: ResourceInput;
}

export interface ResourceOutboxOperation extends ResourceOperationDraft {
  scope: string;
  projectId: string;
  userId: string;
  status: ResourceOperationStatus;
  createdAt: string;
  lastAttemptAt?: string;
  attempts: number;
  code?: string;
  lastError?: string;
  optimisticResource: ResourceItem | null;
  previousResource: ResourceItem | null;
}

export interface DisplayResource extends ResourceItem {
  syncStatus?: ResourceOperationStatus;
  syncMessage?: string;
  syncOperationId?: string;
  syncErrorCode?: string;
}

interface ResourceSnapshot {
  scope: string;
  projectId: string;
  userId: string;
  resources: ResourceItem[];
  savedAt: string;
}

interface ResourceCacheMetadata {
  scope: string;
  projectId: string;
  userId: string;
  canManageResources: boolean | null;
  permissionSavedAt?: string;
}

export interface ResourceCacheBundle {
  snapshot: ResourceItem[] | null;
  snapshotSavedAt: string | null;
  operations: ResourceOutboxOperation[];
  canManageResources: boolean | null;
}

function openResourceCache(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("El almacenamiento local de Recursos no está disponible."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        database.createObjectStore(SNAPSHOTS_STORE, { keyPath: "scope" });
      }
      if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
        const operations = database.createObjectStore(OPERATIONS_STORE, {
          keyPath: ["scope", "operationId"],
        });
        operations.createIndex("scope", "scope", { unique: false });
        operations.createIndex("resourceKey", ["scope", "resourceId"], { unique: false });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "scope" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el almacenamiento local de Recursos."));
    request.onblocked = () => reject(new Error("El almacenamiento local de Recursos está bloqueado."));
  });
}

export function getResourceCacheIdentity(userId: string): ResourceCacheIdentity {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!userId || !configuredUrl) {
    throw new Error("No se pudo determinar la cuenta y el proyecto para guardar Recursos.");
  }

  let projectId: string;
  try {
    projectId = new URL(configuredUrl).host.toLowerCase();
  } catch {
    throw new Error("La configuración del proyecto para el almacenamiento local no es válida.");
  }

  return {
    projectId,
    userId,
    scope: `${projectId}:${userId}`,
  };
}

function isResourceItem(value: unknown): value is ResourceItem {
  if (!value || typeof value !== "object") return false;
  const resource = value as Partial<ResourceItem>;
  return typeof resource.id === "string"
    && typeof resource.name === "string"
    && typeof resource.category === "string"
    && typeof resource.quantity === "number"
    && Number.isInteger(resource.quantity)
    && resource.quantity >= 0
    && typeof resource.storedIn === "string"
    && Array.isArray(resource.notes)
    && resource.notes.every((note) => typeof note === "string")
    && typeof resource.version === "number"
    && Number.isSafeInteger(resource.version)
    && resource.version >= 1
    && typeof resource.updatedAt === "string"
    && !Number.isNaN(Date.parse(resource.updatedAt));
}

function isResourceInput(value: unknown): value is ResourceInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<ResourceInput>;
  return typeof input.name === "string"
    && typeof input.category === "string"
    && typeof input.quantity === "number"
    && Number.isInteger(input.quantity)
    && input.quantity >= 0
    && typeof input.storedIn === "string"
    && Array.isArray(input.notes)
    && input.notes.every((note) => typeof note === "string");
}

function isOutboxOperation(
  value: unknown,
  identity: ResourceCacheIdentity,
): value is ResourceOutboxOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<ResourceOutboxOperation>;
  if (
    operation.scope !== identity.scope
    || operation.projectId !== identity.projectId
    || operation.userId !== identity.userId
    || typeof operation.operationId !== "string"
    || typeof operation.resourceId !== "string"
    || (operation.kind !== "create" && operation.kind !== "update" && operation.kind !== "delete")
    || typeof operation.expectedVersion !== "number"
    || !Number.isSafeInteger(operation.expectedVersion)
    || operation.expectedVersion < 0
    || (operation.status !== "pending" && operation.status !== "conflict" && operation.status !== "rejected")
    || typeof operation.createdAt !== "string"
    || Number.isNaN(Date.parse(operation.createdAt))
    || typeof operation.attempts !== "number"
    || !Number.isSafeInteger(operation.attempts)
    || operation.attempts < 0
    || (operation.kind === "create" && operation.expectedVersion !== 0)
    || (operation.kind !== "create" && operation.expectedVersion < 1)
  ) {
    return false;
  }

  if (operation.kind === "delete") {
    return operation.input === undefined
      && operation.optimisticResource === null
      && isResourceItem(operation.previousResource)
      && operation.previousResource.id === operation.resourceId;
  }

  return isResourceInput(operation.input)
    && isResourceItem(operation.optimisticResource)
    && operation.optimisticResource.id === operation.resourceId
    && operation.previousResource === null;
}

function ensureSnapshot(
  value: unknown,
  identity: ResourceCacheIdentity,
): ResourceSnapshot | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") {
    throw new Error("Los recursos guardados localmente no son válidos.");
  }
  const snapshot = value as Partial<ResourceSnapshot>;
  if (
    snapshot.scope !== identity.scope
    || snapshot.projectId !== identity.projectId
    || snapshot.userId !== identity.userId
    || !Array.isArray(snapshot.resources)
    || !snapshot.resources.every(isResourceItem)
    || new Set(snapshot.resources.map((resource) => resource.id)).size !== snapshot.resources.length
    || typeof snapshot.savedAt !== "string"
    || Number.isNaN(Date.parse(snapshot.savedAt))
  ) {
    throw new Error("Los recursos guardados localmente no corresponden a esta cuenta y proyecto.");
  }
  return snapshot as ResourceSnapshot;
}

function ensureMetadata(
  value: unknown,
  identity: ResourceCacheIdentity,
): ResourceCacheMetadata | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") {
    throw new Error("Los permisos guardados localmente no son válidos.");
  }
  const metadata = value as Partial<ResourceCacheMetadata>;
  if (
    metadata.scope !== identity.scope
    || metadata.projectId !== identity.projectId
    || metadata.userId !== identity.userId
    || (metadata.canManageResources !== null && typeof metadata.canManageResources !== "boolean")
  ) {
    throw new Error("Los permisos guardados localmente no corresponden a esta cuenta y proyecto.");
  }
  return metadata as ResourceCacheMetadata;
}

function sortOperations(operations: ResourceOutboxOperation[]) {
  return [...operations].sort((left, right) => {
    if (left.resourceId === right.resourceId && left.expectedVersion !== right.expectedVersion) {
      return left.expectedVersion - right.expectedVersion;
    }
    return left.createdAt.localeCompare(right.createdAt)
      || left.operationId.localeCompare(right.operationId);
  });
}

export function mergeResourcesWithOutbox(
  serverResources: ResourceItem[],
  operations: ResourceOutboxOperation[],
): DisplayResource[] {
  const resources = new Map<string, DisplayResource>(
    serverResources.map((resource) => [resource.id, resource]),
  );
  const blockedResourceIds = new Set<string>();

  sortOperations(operations).forEach((operation) => {
    if (blockedResourceIds.has(operation.resourceId)) return;

    if (operation.status === "conflict" || operation.status === "rejected") {
      const visibleResource = operation.kind === "delete"
        ? operation.previousResource
        : operation.optimisticResource;
      if (visibleResource) {
        resources.set(operation.resourceId, {
          ...visibleResource,
          syncStatus: operation.status,
          syncMessage: operation.lastError,
          syncOperationId: operation.operationId,
          syncErrorCode: operation.code,
        });
      }
      blockedResourceIds.add(operation.resourceId);
      return;
    }

    if (operation.kind === "delete") {
      resources.delete(operation.resourceId);
    } else if (operation.optimisticResource) {
      resources.set(operation.resourceId, {
        ...operation.optimisticResource,
        syncStatus: "pending",
        syncMessage: operation.lastError,
        syncOperationId: operation.operationId,
      });
    }
  });

  return [...resources.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "es") || left.id.localeCompare(right.id),
  );
}

export async function readResourceCache(
  identity: ResourceCacheIdentity,
): Promise<ResourceCacheBundle> {
  const database = await openResourceCache();
  try {
    return await new Promise<ResourceCacheBundle>((resolve, reject) => {
      const transaction = database.transaction(
        [SNAPSHOTS_STORE, OPERATIONS_STORE, METADATA_STORE],
        "readonly",
      );
      const snapshotRequest = transaction.objectStore(SNAPSHOTS_STORE).get(identity.scope);
      const operationsRequest = transaction.objectStore(OPERATIONS_STORE).index("scope").getAll(identity.scope);
      const metadataRequest = transaction.objectStore(METADATA_STORE).get(identity.scope);
      let snapshotValue: unknown;
      let operationValues: unknown[] = [];
      let metadataValue: unknown;

      snapshotRequest.onsuccess = () => { snapshotValue = snapshotRequest.result; };
      operationsRequest.onsuccess = () => { operationValues = operationsRequest.result as unknown[]; };
      metadataRequest.onsuccess = () => { metadataValue = metadataRequest.result; };
      transaction.oncomplete = () => {
        try {
          const snapshot = ensureSnapshot(snapshotValue, identity);
          if (!operationValues.every((operation) => isOutboxOperation(operation, identity))) {
            throw new Error("La cola de sincronización local de Recursos no es válida.");
          }
          const metadata = ensureMetadata(metadataValue, identity);
          resolve({
            snapshot: snapshot?.resources ?? null,
            snapshotSavedAt: snapshot?.savedAt ?? null,
            operations: sortOperations(operationValues as ResourceOutboxOperation[]),
            canManageResources: metadata?.canManageResources ?? null,
          });
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer el almacenamiento local de Recursos."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo leer el almacenamiento local de Recursos."));
    });
  } finally {
    database.close();
  }
}

export async function saveResourcePermission(
  identity: ResourceCacheIdentity,
  canManageResources: boolean,
): Promise<void> {
  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      transaction.objectStore(METADATA_STORE).put({
        ...identity,
        canManageResources,
        permissionSavedAt: new Date().toISOString(),
      } satisfies ResourceCacheMetadata);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el permiso local de Recursos."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar el permiso local de Recursos."));
    });
  } finally {
    database.close();
  }
}

export async function saveResourceSnapshot(
  identity: ResourceCacheIdentity,
  resources: ResourceItem[],
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (
    !resources.every(isResourceItem)
    || new Set(resources.map((resource) => resource.id)).size !== resources.length
    || Number.isNaN(Date.parse(fetchedAt))
  ) {
    throw new Error("La respuesta de Recursos no es válida para guardarla localmente.");
  }

  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
      const store = transaction.objectStore(SNAPSHOTS_STORE);
      const request = store.get(identity.scope);
      request.onsuccess = () => {
        try {
          const current = ensureSnapshot(request.result, identity);
          if (current && Date.parse(current.savedAt) > Date.parse(fetchedAt)) return;
          store.put({
            ...identity,
            resources,
            savedAt: fetchedAt,
          } satisfies ResourceSnapshot);
        } catch (error) {
          transaction.abort();
          reject(error instanceof Error ? error : new Error("No se pudo guardar el inventario."));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer el inventario local."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el inventario en este equipo."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar el inventario en este equipo."));
    });
  } finally {
    database.close();
  }
}

export async function enqueueResourceOperations(
  identity: ResourceCacheIdentity,
  drafts: ResourceOperationDraft[],
): Promise<void> {
  if (!drafts.length) return;
  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const snapshotRequest = snapshots.get(identity.scope);
      const operationsRequest = operations.index("scope").getAll(identity.scope);
      let snapshotReady = false;
      let operationsReady = false;
      let snapshotValue: unknown;
      let operationValues: unknown[] = [];
      let requestError: Error | null = null;

      const enqueue = () => {
        if (!snapshotReady || !operationsReady || requestError) return;
        try {
          const snapshot = ensureSnapshot(snapshotValue, identity);
          if (!operationValues.every((operation) => isOutboxOperation(operation, identity))) {
            throw new Error("La cola de sincronización local de Recursos no es válida.");
          }
          const queue = operationValues as ResourceOutboxOperation[];
          const displayed = mergeResourcesWithOutbox(snapshot?.resources ?? [], queue);
          const effectiveResources = new Map(displayed.map((resource) => [resource.id, resource]));
          const blockedIds = new Set(queue
            .filter((operation) => operation.status !== "pending")
            .map((operation) => operation.resourceId));

          drafts.forEach((draft) => {
            if (!draft.operationId || !draft.resourceId) {
              throw new Error("La operación local de Recursos no tiene identificadores válidos.");
            }
            if (queue.some((operation) => operation.operationId === draft.operationId)) {
              throw new Error("El identificador de operación ya existe en la cola local.");
            }
            if (blockedIds.has(draft.resourceId)) {
              throw new Error("Este recurso tiene un cambio pendiente que requiere revisión antes de editarse.");
            }

            const now = new Date().toISOString();
            let optimisticResource: ResourceItem | null = null;
            let previousResource: ResourceItem | null = null;

            if (draft.kind === "create") {
              if (draft.expectedVersion !== 0 || !isResourceInput(draft.input)) {
                throw new Error("Los datos del nuevo recurso no son válidos.");
              }
              if (effectiveResources.has(draft.resourceId)) {
                throw new Error("El identificador del nuevo recurso ya está en uso.");
              }
              optimisticResource = {
                id: draft.resourceId,
                ...draft.input,
                version: 1,
                updatedAt: now,
              };
            } else {
              const current = effectiveResources.get(draft.resourceId);
              if (!current || current.version !== draft.expectedVersion) {
                throw new Error("La versión local del recurso cambió; actualiza el inventario antes de continuar.");
              }

              if (draft.kind === "update") {
                if (!isResourceInput(draft.input)) {
                  throw new Error("Los datos para modificar el recurso no son válidos.");
                }
                optimisticResource = {
                  ...current,
                  ...draft.input,
                  version: draft.expectedVersion + 1,
                  updatedAt: now,
                };
              } else {
                previousResource = current;
              }
            }

            const operation: ResourceOutboxOperation = {
              ...identity,
              ...draft,
              status: "pending",
              createdAt: now,
              attempts: 0,
              optimisticResource,
              previousResource,
            };
            operations.add(operation);
            if (draft.kind === "delete") {
              effectiveResources.delete(draft.resourceId);
            } else if (optimisticResource) {
              effectiveResources.set(draft.resourceId, optimisticResource);
            }
            queue.push(operation);
          });
        } catch (error) {
          requestError = error instanceof Error ? error : new Error("No se pudo encolar el cambio local.");
          transaction.abort();
        }
      };

      snapshotRequest.onsuccess = () => {
        snapshotReady = true;
        snapshotValue = snapshotRequest.result;
        enqueue();
      };
      operationsRequest.onsuccess = () => {
        operationsReady = true;
        operationValues = operationsRequest.result as unknown[];
        enqueue();
      };
      snapshotRequest.onerror = () => {
        requestError = snapshotRequest.error ?? new Error("No se pudo leer el inventario local.");
        transaction.abort();
      };
      operationsRequest.onerror = () => {
        requestError = operationsRequest.error ?? new Error("No se pudo leer la cola local.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(requestError ?? transaction.error ?? new Error("No se pudo guardar el cambio pendiente."));
      transaction.onabort = () => reject(requestError ?? transaction.error ?? new Error("No se pudo guardar el cambio pendiente."));
    });
  } finally {
    database.close();
  }
}

async function updateOutboxOperation(
  identity: ResourceCacheIdentity,
  operationId: string,
  update: (operation: ResourceOutboxOperation) => void,
): Promise<void> {
  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      request.onsuccess = () => {
        if (!request.result) return;
        const operation = request.result as unknown;
        if (!isOutboxOperation(operation, identity)) {
          transaction.abort();
          reject(new Error("La operación pendiente de Recursos no corresponde a esta cuenta."));
          return;
        }
        try {
          update(operation);
          store.put(operation);
        } catch (error) {
          transaction.abort();
          reject(error instanceof Error ? error : new Error("No se pudo actualizar la operación pendiente."));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer la operación pendiente."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo actualizar la operación pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo actualizar la operación pendiente."));
    });
  } finally {
    database.close();
  }
}

export function markResourceOperationProblem(
  identity: ResourceCacheIdentity,
  operationId: string,
  status: "conflict" | "rejected",
  code: string,
  message: string,
): Promise<void> {
  return updateOutboxOperation(identity, operationId, (operation) => {
    operation.status = status;
    operation.code = code;
    operation.lastError = message;
  });
}

export function markResourceOperationError(
  identity: ResourceCacheIdentity,
  operationId: string,
  message: string,
): Promise<void> {
  return updateOutboxOperation(identity, operationId, (operation) => {
    operation.attempts += 1;
    operation.lastAttemptAt = new Date().toISOString();
    operation.lastError = message;
  });
}

export function resetRejectedResourceOperationForRetry(
  identity: ResourceCacheIdentity,
  operationId: string,
): Promise<void> {
  return updateOutboxOperation(identity, operationId, (operation) => {
    if (
      operation.status !== "rejected"
      || (operation.code !== "not_authorized" && operation.code !== "sync_error")
    ) {
      throw new Error("Este cambio requiere revisión y no se puede reintentar automáticamente.");
    }
    operation.status = "pending";
    operation.code = undefined;
    operation.lastError = undefined;
  });
}

export async function completeResourceOperation(
  identity: ResourceCacheIdentity,
  operationId: string,
  confirmedResource: ResourceItem | null,
  removeWhenNoConfirmedResource = false,
): Promise<void> {
  if (confirmedResource && !isResourceItem(confirmedResource)) {
    throw new Error("La confirmación de Supabase devolvió un recurso no válido.");
  }

  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const snapshotRequest = snapshots.get(identity.scope);
      const operationRequest = operations.get([identity.scope, operationId]);
      let snapshotValue: unknown;
      let operationValue: unknown;
      let snapshotReady = false;
      let operationReady = false;
      let updateError: Error | null = null;

      const commit = () => {
        if (!snapshotReady || !operationReady || !operationValue || updateError) return;
        try {
          if (!isOutboxOperation(operationValue, identity)) {
            throw new Error("La operación confirmada no corresponde a esta cuenta.");
          }
          if (confirmedResource && confirmedResource.id !== operationValue.resourceId) {
            throw new Error("La respuesta confirmada pertenece a otro recurso.");
          }
          const snapshot = ensureSnapshot(snapshotValue, identity);
          const resources = new Map((snapshot?.resources ?? []).map((resource) => [resource.id, resource]));
          const resourceId = (operationValue as ResourceOutboxOperation).resourceId;
          const cachedResource = resources.get(resourceId);
          if (confirmedResource) {
            if (!cachedResource || cachedResource.version <= confirmedResource.version) {
              resources.set(resourceId, confirmedResource);
            }
          } else if (removeWhenNoConfirmedResource) {
            resources.delete(resourceId);
          }

          snapshots.put({
            ...identity,
            resources: [...resources.values()],
            savedAt: new Date().toISOString(),
          } satisfies ResourceSnapshot);
          operations.delete([identity.scope, operationId]);
        } catch (error) {
          updateError = error instanceof Error ? error : new Error("No se pudo confirmar la operación local.");
          transaction.abort();
        }
      };

      snapshotRequest.onsuccess = () => {
        snapshotReady = true;
        snapshotValue = snapshotRequest.result;
        commit();
      };
      operationRequest.onsuccess = () => {
        operationReady = true;
        operationValue = operationRequest.result;
        commit();
      };
      snapshotRequest.onerror = () => {
        updateError = snapshotRequest.error ?? new Error("No se pudo leer el inventario local.");
        transaction.abort();
      };
      operationRequest.onerror = () => {
        updateError = operationRequest.error ?? new Error("No se pudo leer la operación local.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(updateError ?? transaction.error ?? new Error("No se pudo confirmar el cambio local."));
      transaction.onabort = () => reject(updateError ?? transaction.error ?? new Error("No se pudo confirmar el cambio local."));
    });
  } finally {
    database.close();
  }
}

export async function discardResourceOperations(
  identity: ResourceCacheIdentity,
  resourceId: string,
): Promise<void> {
  const database = await openResourceCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.index("resourceKey").getAll([identity.scope, resourceId]);
      request.onsuccess = () => {
        (request.result as ResourceOutboxOperation[])
          .forEach((operation) => store.delete([identity.scope, operation.operationId]));
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudieron leer los cambios locales."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron descartar los cambios locales."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudieron descartar los cambios locales."));
    });
  } finally {
    database.close();
  }
}
