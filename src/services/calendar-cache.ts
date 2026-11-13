import type {
  CalendarEvent,
  CalendarCacheMetadata,
  CalendarOutboxCancelOperation,
  CalendarOutboxOperation,
  CalendarOutboxSaveOperation,
  AssignableWorker,
  SaveCalendarEventInput,
} from "../types/calendar";

const DATABASE_NAME = "agenda-juventud-calendar";
const DATABASE_VERSION = 3;
const SNAPSHOTS_STORE = "snapshots";
const OPERATIONS_STORE = "operations";
const METADATA_STORE = "metadata";

interface CalendarSnapshot {
  userId: string;
  events: CalendarEvent[];
  savedAt: string;
}

function openCalendarCache(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("El almacenamiento local de la agenda no está disponible."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        request.result.createObjectStore(SNAPSHOTS_STORE, { keyPath: "userId" });
      }
      if (!request.result.objectStoreNames.contains(OPERATIONS_STORE)) {
        const operations = request.result.createObjectStore(OPERATIONS_STORE, {
          keyPath: ["userId", "operationId"],
        });
        operations.createIndex("userId", "userId", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
        request.result.createObjectStore(METADATA_STORE, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir la agenda guardada."));
    request.onblocked = () => reject(new Error("El almacenamiento local de la agenda está bloqueado."));
  });
}

export async function readCachedAssignableWorkers(userId: string): Promise<AssignableWorker[] | null> {
  const metadata = await readCacheMetadata(userId);
  if (!metadata || !Array.isArray(metadata.assignableWorkers)) return null;
  if (!metadata.assignableWorkers.every((worker) => (
    !!worker
    && typeof worker.id === "string"
    && worker.id !== userId
    && typeof worker.name === "string"
    && (worker.role === "administrador" || worker.role === "empleado")
  )) || new Set(metadata.assignableWorkers.map((worker) => worker.id)).size !== metadata.assignableWorkers.length) {
    throw new Error("La lista guardada de trabajadores no es válida para esta cuenta.");
  }
  return metadata.assignableWorkers;
}

export async function saveAuthorizedAssignableWorkers(
  userId: string,
  workers: AssignableWorker[],
): Promise<void> {
  if (!userId || !workers.every((worker) => (
    typeof worker.id === "string"
    && worker.id !== userId
    && typeof worker.name === "string"
    && (worker.role === "administrador" || worker.role === "empleado")
  )) || new Set(workers.map((worker) => worker.id)).size !== workers.length) {
    throw new Error("La lista autorizada de trabajadores no es válida.");
  }

  await updateCacheMetadata(userId, (metadata) => {
    metadata.assignableWorkers = workers;
    metadata.workersSavedAt = new Date().toISOString();
  });
}

export async function readLastSuccessfulCalendarSync(userId: string): Promise<string | null> {
  const metadata = await readCacheMetadata(userId);
  return metadata?.lastSuccessfulSyncAt ?? null;
}

export async function recordSuccessfulCalendarSync(userId: string): Promise<void> {
  await updateCacheMetadata(userId, (metadata) => {
    metadata.lastSuccessfulSyncAt = new Date().toISOString();
  });
}

async function readCacheMetadata(userId: string): Promise<CalendarCacheMetadata | null> {
  const database = await openCalendarCache();
  try {
    return await new Promise<CalendarCacheMetadata | null>((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readonly");
      const request = transaction.objectStore(METADATA_STORE).get(userId);
      request.onsuccess = () => {
        const metadata = request.result as CalendarCacheMetadata | undefined;
        if (metadata && metadata.userId !== userId) {
          transaction.abort();
          reject(new Error("La información local de la agenda no corresponde a esta cuenta."));
          return;
        }
        resolve(metadata ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer la información local de la agenda."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo leer la información local de la agenda."));
    });
  } finally {
    database.close();
  }
}

async function updateCacheMetadata(
  userId: string,
  update: (metadata: CalendarCacheMetadata) => void,
): Promise<void> {
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.get(userId);
      request.onsuccess = () => {
        const metadata = (request.result as CalendarCacheMetadata | undefined) ?? { userId };
        if (metadata.userId !== userId) {
          transaction.abort();
          reject(new Error("La información local de la agenda no corresponde a esta cuenta."));
          return;
        }
        update(metadata);
        store.put(metadata);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la información local de la agenda."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar la información local de la agenda."));
    });
  } finally {
    database.close();
  }
}

function isCalendarEventForUser(value: unknown, userId: string): value is CalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CalendarEvent>;
  return typeof event.id === "string"
    && typeof event.version === "number"
    && typeof event.title === "string"
    && typeof event.description === "string"
    && typeof event.category === "string"
    && typeof event.date === "string"
    && typeof event.startTime === "string"
    && typeof event.endTime === "string"
    && typeof event.reminderEnabled === "boolean"
    && typeof event.reminderValue === "number"
    && (event.reminderUnit === "minutes"
      || event.reminderUnit === "hours"
      || event.reminderUnit === "days"
      || event.reminderUnit === "weeks")
    && !!event.createdBy
    && typeof event.createdBy.id === "string"
    && typeof event.createdBy.name === "string"
    && Array.isArray(event.assignedWorkers)
    && event.assignedWorkers.every((worker) => (
      !!worker
      && typeof worker.id === "string"
      && typeof worker.name === "string"
    ))
    && (event.createdBy.id === userId
      || event.assignedWorkers.some((worker) => worker.id === userId));
}

export async function readCalendarSnapshot(userId: string): Promise<CalendarEvent[] | null> {
  const database = await openCalendarCache();
  try {
    const snapshot = await new Promise<CalendarSnapshot | undefined>((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOTS_STORE, "readonly");
      const request = transaction.objectStore(SNAPSHOTS_STORE).get(userId);
      request.onsuccess = () => resolve(request.result as CalendarSnapshot | undefined);
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer la agenda guardada."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo leer la agenda guardada."));
    });

    if (!snapshot) return null;
    if (
      snapshot.userId !== userId
      || !Array.isArray(snapshot.events)
      || !snapshot.events.every((event) => isCalendarEventForUser(event, userId))
      || new Set(snapshot.events.map((event) => event.id)).size !== snapshot.events.length
    ) {
      throw new Error("La agenda guardada no es válida para esta cuenta.");
    }

    return snapshot.events;
  } finally {
    database.close();
  }
}

export async function saveCalendarSnapshot(userId: string, events: CalendarEvent[]): Promise<void> {
  if (!userId || !events.every((event) => isCalendarEventForUser(event, userId))) {
    throw new Error("La agenda recibida no es válida para guardarla en este equipo.");
  }
  if (new Set(events.map((event) => event.id)).size !== events.length) {
    throw new Error("La agenda recibida contiene eventos duplicados.");
  }

  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
      transaction.objectStore(SNAPSHOTS_STORE).put({
        userId,
        events,
        savedAt: new Date().toISOString(),
      } satisfies CalendarSnapshot);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la agenda en este equipo."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar la agenda en este equipo."));
    });
  } finally {
    database.close();
  }
}

function isPersonalEventForUser(event: CalendarEvent, userId: string) {
  return event.createdBy.id === userId && event.assignedWorkers.length === 0;
}

function isSharedDraftSave(
  operation: CalendarOutboxOperation,
  userId: string,
): operation is CalendarOutboxSaveOperation {
  if (operation.kind !== "save") return false;
  const participantIds = operation.input.participantIds;
  const snapshotIds = operation.eventSnapshot.assignedWorkers.map((worker) => worker.id);
  return operation.scope === "shared"
    && operation.input.expectedVersion === 0
    && operation.eventSnapshot.createdBy.id === userId
    && !!participantIds
    && participantIds.length > 0
    && new Set(participantIds).size === participantIds.length
    && snapshotIds.length === participantIds.length
    && participantIds.every((id) => snapshotIds.includes(id));
}

function isSharedUpdateSave(
  operation: CalendarOutboxOperation,
  userId: string,
): operation is CalendarOutboxSaveOperation {
  if (operation.kind !== "save") return false;
  const participantIds = operation.input.participantIds;
  const snapshotIds = operation.eventSnapshot.assignedWorkers.map((worker) => worker.id);
  return operation.scope === "shared-update"
    && operation.input.expectedVersion >= 1
    && operation.eventSnapshot.version === operation.input.expectedVersion + 1
    && operation.eventSnapshot.createdBy.id === userId
    && (participantIds === null
      || (new Set(participantIds).size === participantIds.length
        && participantIds.length === snapshotIds.length
        && participantIds.every((id) => snapshotIds.includes(id))));
}

function ensureSnapshotEvents(snapshot: CalendarSnapshot | undefined, userId: string) {
  if (!snapshot) return [] as CalendarEvent[];
  if (
    snapshot.userId !== userId
    || !Array.isArray(snapshot.events)
    || !snapshot.events.every((event) => isCalendarEventForUser(event, userId))
  ) {
    throw new Error("La agenda guardada no es válida para esta cuenta.");
  }
  return snapshot.events;
}

export async function readCalendarOutbox(userId: string): Promise<CalendarOutboxOperation[]> {
  const database = await openCalendarCache();
  try {
    return await new Promise<CalendarOutboxOperation[]>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readonly");
      const request = transaction.objectStore(OPERATIONS_STORE).index("userId").getAll(userId);
      let operations: CalendarOutboxOperation[] = [];
      request.onsuccess = () => {
        const values = request.result as CalendarOutboxOperation[];
        if (!values.every((operation) => (
          operation.userId === userId
          && typeof operation.operationId === "string"
          && typeof operation.eventId === "string"
          && (operation.kind === "save" || operation.kind === "cancel")
          && ["pending", "conflict", "rejected"].includes(operation.status)
          && isCalendarEventForUser(operation.eventSnapshot, userId)
          && operation.eventSnapshot.id === operation.eventId
          && (operation.kind === "cancel"
            ? (
              operation.expectedVersion >= 1
              && operation.eventSnapshot.version === operation.expectedVersion
              && (operation.scope === "shared"
                ? operation.eventSnapshot.createdBy.id === userId
                : (operation.scope === undefined || operation.scope === "personal")
                  && isPersonalEventForUser(operation.eventSnapshot, userId)
              )
            )
            : (
              operation.input.operationId === operation.operationId
              && operation.input.eventId === operation.eventId
              && (operation.scope === "shared"
                ? isSharedDraftSave(operation, userId)
                : operation.scope === "shared-update"
                  ? isSharedUpdateSave(operation, userId)
                  : (operation.scope === undefined || operation.scope === "personal")
                    && operation.input.participantIds !== null
                    && operation.input.participantIds.length === 0
                    && isPersonalEventForUser(operation.eventSnapshot, userId))
            ))
        ))) {
          transaction.abort();
          reject(new Error("La cola de sincronización guardada no es válida."));
          return;
        }
        operations = values;
      };
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer la cola de sincronización."));
      transaction.oncomplete = () => {
        operations.sort((left, right) => {
          if (left.eventId === right.eventId) {
            const leftVersion = left.kind === "save" ? left.input.expectedVersion : left.expectedVersion;
            const rightVersion = right.kind === "save" ? right.input.expectedVersion : right.expectedVersion;
            if (leftVersion !== rightVersion) return leftVersion - rightVersion;
          }
          return left.createdAt.localeCompare(right.createdAt);
        });
        resolve(operations);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo leer la cola de sincronización."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo leer la cola de sincronización."));
    });
  } finally {
    database.close();
  }
}

export async function enqueueOfflineSave(
  userId: string,
  input: SaveCalendarEventInput,
  eventSnapshot: CalendarEvent,
  scope: "personal" | "shared" | "shared-update" = "personal",
  supersedesOperationId: string | null = null,
): Promise<void> {
  if (!userId || input.eventId !== eventSnapshot.id || !isCalendarEventForUser(eventSnapshot, userId)) {
    throw new Error("El cambio pendiente no es válido para esta cuenta.");
  }
  if (scope === "personal") {
    if (
      input.participantIds === null
      || input.participantIds.length !== 0
      || !isPersonalEventForUser(eventSnapshot, userId)
    ) {
      throw new Error("Solo es posible guardar cambios personales pendientes.");
    }
  } else if (scope === "shared") {
    if (
      input.expectedVersion !== 0
      || !input.participantIds
      || input.participantIds.length === 0
      || eventSnapshot.createdBy.id !== userId
      || eventSnapshot.assignedWorkers.length !== input.participantIds.length
      || !input.participantIds.every((id) => eventSnapshot.assignedWorkers.some((worker) => worker.id === id))
    ) {
      throw new Error("El borrador compartido no es válido.");
    }
  } else if (
    scope === "shared-update"
    && (input.expectedVersion < 1
      || eventSnapshot.createdBy.id !== userId
      || eventSnapshot.version !== input.expectedVersion + 1
      || (input.participantIds !== null
        && (new Set(input.participantIds).size !== input.participantIds.length
          || input.participantIds.length !== eventSnapshot.assignedWorkers.length
          || !input.participantIds.every((id) => eventSnapshot.assignedWorkers.some((worker) => worker.id === id)))))
  ) {
    throw new Error("La actualización compartida no es válida.");
  }

  const operation: CalendarOutboxSaveOperation = {
    userId,
    operationId: input.operationId,
    eventId: input.eventId,
    kind: "save",
    scope,
    attempted: false,
    supersedesOperationId,
    input,
    eventSnapshot,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const storeNames = scope !== "personal"
        ? [SNAPSHOTS_STORE, OPERATIONS_STORE, METADATA_STORE]
        : [SNAPSHOTS_STORE, OPERATIONS_STORE];
      const transaction = database.transaction(storeNames, "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const snapshotRequest = snapshots.get(userId);
      snapshotRequest.onsuccess = () => {
        try {
          const events = ensureSnapshotEvents(snapshotRequest.result as CalendarSnapshot | undefined, userId);
          const currentEvent = events.find((event) => event.id === eventSnapshot.id);
          if (scope === "personal" && input.expectedVersion > 0
            && (!currentEvent
              || !isPersonalEventForUser(currentEvent, userId)
              || currentEvent.version !== input.expectedVersion)) {
            throw new Error("La versión local del evento no coincide con la operación pendiente.");
          }
          if (scope === "shared" && currentEvent) {
            if (!currentEvent.createdBy || currentEvent.createdBy.id !== userId) {
              throw new Error("No se puede modificar un evento compartido ya sincronizado sin conexión.");
            }
          }
          if (scope === "shared-update" && (
            !currentEvent
            || currentEvent.createdBy.id !== userId
            || (input.participantIds === null
              && currentEvent.assignedWorkers.map((worker) => worker.id).sort().join(",")
                !== eventSnapshot.assignedWorkers.map((worker) => worker.id).sort().join(","))
          )) {
            throw new Error("No se puede actualizar un evento compartido ajeno o no disponible.");
          }

          const saveSnapshotAndOperation = (replacePendingOperation = false) => {
            const nextEvents = events.filter((event) => event.id !== eventSnapshot.id);
            nextEvents.push(eventSnapshot);
            snapshots.put({ userId, events: nextEvents, savedAt: new Date().toISOString() } satisfies CalendarSnapshot);
            if (replacePendingOperation) {
              operations.put(operation);
            } else {
              operations.add(operation);
            }
          };

          if (scope === "shared") {
            const metadataRequest = transaction.objectStore(METADATA_STORE).get(userId);
            metadataRequest.onsuccess = () => {
              try {
                const metadata = metadataRequest.result as CalendarCacheMetadata | undefined;
                const workers = metadata?.assignableWorkers;
                if (!Array.isArray(workers)
                  || !input.participantIds?.every((id) => workers.some((worker) => worker.id === id))) {
                  throw new Error("No hay una lista autorizada de trabajadores guardada para preparar este borrador.");
                }

                const priorOperationsRequest = operations.index("userId").getAll(userId);
                priorOperationsRequest.onsuccess = () => {
                  try {
                    const priorOperations = priorOperationsRequest.result as CalendarOutboxOperation[];
                    const sameOperation = priorOperations.find((entry) => (
                      entry.operationId === input.operationId
                      && entry.eventId === input.eventId
                      && entry.kind === "save"
                      && entry.scope === "shared"
                    ));
                    if (sameOperation) {
                      if (
                        sameOperation.kind !== "save"
                        || sameOperation.status !== "pending"
                        || sameOperation.attempted
                      ) {
                        throw new Error("Este borrador ya se intentó sincronizar; primero reintenta o resuelve el resultado.");
                      }
                      saveSnapshotAndOperation(true);
                      return;
                    }

                    const priorOperation = input.resolvesOperationId
                      ? priorOperations.find((entry) => entry.operationId === input.resolvesOperationId)
                      : priorOperations.find((entry) => (
                        entry.kind === "save"
                        && entry.scope === "shared"
                        && entry.eventId === input.eventId
                        && entry.status === "rejected"
                        && entry.input.expectedVersion === 0
                      ));
                    const canRetryCreate = priorOperation?.kind === "save"
                      && priorOperation.scope === "shared"
                      && priorOperation.eventId === input.eventId
                      && priorOperation.input.expectedVersion === 0
                      && (input.resolvesOperationId
                        ? priorOperation.status === "conflict"
                        : priorOperation.status === "rejected");
                    if (currentEvent && !canRetryCreate) {
                      throw new Error("No se encontró el borrador local que se intenta modificar.");
                    }
                    if (input.resolvesOperationId && !canRetryCreate) {
                      throw new Error("No se encontró el conflicto previo que se intenta resolver.");
                    }
                    saveSnapshotAndOperation();
                  } catch (error) {
                    transaction.abort();
                    reject(error);
                  }
                };
              } catch (error) {
                transaction.abort();
                reject(error);
              }
            };
          } else if (scope === "shared-update") {
            const metadataRequest = transaction.objectStore(METADATA_STORE).get(userId);
            metadataRequest.onsuccess = () => {
              const metadata = metadataRequest.result as CalendarCacheMetadata | undefined;
            if (metadata && metadata.userId !== userId) {
                transaction.abort();
                reject(new Error("No hay información autorizada para esta cuenta."));
                return;
              }
              if (input.participantIds !== null
                && (!Array.isArray(metadata?.assignableWorkers)
                  || !input.participantIds.every((id) => (
                    metadata?.assignableWorkers?.some((worker) => worker.id === id)
                  )))) {
                transaction.abort();
                reject(new Error("No hay una lista autorizada de trabajadores guardada para este cambio."));
                return;
              }

              const priorOperationsRequest = operations.index("userId").getAll(userId);
              priorOperationsRequest.onsuccess = () => {
                try {
                  const priorOperations = priorOperationsRequest.result as CalendarOutboxOperation[];
                  const eventOperations = priorOperations.filter((entry) => (
                    entry.eventId === input.eventId
                    && (entry.kind === "cancel" ? entry.scope === "shared" : entry.scope === "shared-update")
                  ));
                  const sameOperation = eventOperations.find((entry) => (
                    entry.kind === "save" && entry.operationId === input.operationId
                  ));

                  if (sameOperation) {
                    if (
                      sameOperation.kind !== "save"
                      || sameOperation.status !== "pending"
                      || sameOperation.attempted
                      || sameOperation.input.expectedVersion !== input.expectedVersion
                      || currentEvent?.version !== eventSnapshot.version
                    ) {
                      throw new Error("Esta actualización ya se envió y no se puede cambiar con el mismo identificador.");
                    }
                    saveSnapshotAndOperation(true);
                    return;
                  }

                  const correction = input.resolvesOperationId
                    ? eventOperations.find((entry) => entry.operationId === input.resolvesOperationId)
                    : supersedesOperationId
                      ? eventOperations.find((entry) => entry.operationId === supersedesOperationId)
                      : undefined;
                  if (input.resolvesOperationId
                    && (correction?.kind !== "save" || correction.status !== "conflict")) {
                    throw new Error("No se encontró el conflicto de actualización que se intenta resolver.");
                  }
                  if (supersedesOperationId
                    && (correction?.kind !== "save" || correction.status !== "rejected")) {
                    throw new Error("No se encontró el rechazo de actualización que se intenta corregir.");
                  }

                  const hasUncertainPending = eventOperations.some((entry) => (
                    entry.status === "pending"
                    && entry.kind === "save"
                    && entry.attempted
                  ));
                  if ((input.resolvesOperationId || supersedesOperationId) && hasUncertainPending) {
                    throw new Error("Hay otra actualización cuyo resultado aún no se conoce. Reinténtala antes de corregir.");
                  }

                  if (input.resolvesOperationId || supersedesOperationId) {
                    eventOperations
                      .filter((entry) => (
                        entry.kind === "save"
                        && entry.scope === "shared-update"
                        && entry.status === "pending"
                        && !entry.attempted
                      ))
                      .forEach((entry) => operations.delete([userId, entry.operationId]));
                    eventOperations
                      .filter((entry) => (
                        entry.kind === "cancel"
                        && entry.scope === "shared"
                        && entry.status === "pending"
                      ))
                      .forEach((entry) => {
                        if (entry.kind !== "cancel") return;
                        entry.expectedVersion = input.expectedVersion + 1;
                        entry.eventSnapshot = eventSnapshot;
                        operations.put(entry);
                      });
                  } else {
                    const hasUnresolvedIssue = eventOperations.some((entry) => (
                      entry.kind === "save"
                      && entry.scope === "shared-update"
                      && (entry.status === "conflict" || entry.status === "rejected")
                    ));
                    if (hasUnresolvedIssue || currentEvent?.version !== input.expectedVersion) {
                      throw new Error("La versión local cambió o requiere resolver un conflicto antes de continuar.");
                    }
                  }

                  saveSnapshotAndOperation();
                } catch (error) {
                  transaction.abort();
                  reject(error);
                }
              };
            };
          } else if (input.expectedVersion === 0 && currentEvent) {
            const priorOperationsRequest = operations.index("userId").getAll(userId);
            priorOperationsRequest.onsuccess = () => {
              const priorOperations = priorOperationsRequest.result as CalendarOutboxOperation[];
              const priorOperation = input.resolvesOperationId
                ? priorOperations.find((entry) => entry.operationId === input.resolvesOperationId)
                : priorOperations.find((entry) => (
                  entry.kind === "save"
                  && entry.eventId === input.eventId
                  && entry.status === "rejected"
                  && entry.input.expectedVersion === 0
                ));
              const canRetryCreate = priorOperation?.kind === "save"
                && priorOperation.eventId === input.eventId
                && priorOperation.input.expectedVersion === 0
                && (input.resolvesOperationId
                  ? priorOperation.status === "conflict"
                  : priorOperation.status === "rejected");
              if (!canRetryCreate) {
                transaction.abort();
                reject(new Error("No se encontró la operación previa de creación que se intenta corregir."));
                return;
              }
              saveSnapshotAndOperation();
            };
          } else {
            saveSnapshotAndOperation();
          }
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el cambio pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar el cambio pendiente."));
    });
  } finally {
    database.close();
  }
}

export async function enqueueOfflineCancel(
  userId: string,
  operation: Omit<CalendarOutboxCancelOperation, "status" | "createdAt">,
): Promise<void> {
  const scope = operation.scope ?? "personal";
  if (
    !userId
    || operation.userId !== userId
    || !isCalendarEventForUser(operation.eventSnapshot, userId)
    || operation.expectedVersion < 1
    || operation.eventSnapshot.version !== operation.expectedVersion
    || (scope === "personal" && !isPersonalEventForUser(operation.eventSnapshot, userId))
    || (scope === "shared" && operation.eventSnapshot.createdBy.id !== userId)
  ) {
    throw new Error("Solo es posible cancelar eventos propios con una versión válida.");
  }

  const queuedOperation: CalendarOutboxCancelOperation = {
    ...operation,
    scope,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const snapshotRequest = snapshots.get(userId);
      snapshotRequest.onsuccess = () => {
        try {
          const events = ensureSnapshotEvents(snapshotRequest.result as CalendarSnapshot | undefined, userId);
          const currentEvent = events.find((event) => event.id === operation.eventId);
          if (
            !currentEvent
            || (scope === "personal" && !isPersonalEventForUser(currentEvent, userId))
            || (scope === "shared" && currentEvent.createdBy.id !== userId)
            || currentEvent.version !== operation.expectedVersion
          ) {
            throw new Error("La versión local del evento no coincide con la cancelación pendiente.");
          }
          const priorOperationsRequest = operations.index("userId").getAll(userId);
          priorOperationsRequest.onsuccess = () => {
            try {
              const priorOperations = priorOperationsRequest.result as CalendarOutboxOperation[];
              if (priorOperations.some((entry) => (
                entry.eventId === operation.eventId
                && entry.kind === "cancel"
                && entry.status === "pending"
              ))) {
                throw new Error("Ya existe una cancelación pendiente para este evento.");
              }
              if (operation.resolvesOperationId && !priorOperations.some((entry) => (
                entry.operationId === operation.resolvesOperationId
                && entry.eventId === operation.eventId
                && entry.kind === "cancel"
                && (entry.scope ?? "personal") === scope
                && entry.status === "conflict"
              ))) {
                throw new Error("No se encontró el conflicto de cancelación que se intenta resolver.");
              }
              if (scope === "shared" && priorOperations.some((entry) => (
                entry.eventId === operation.eventId
                && entry.kind === "save"
                && entry.scope === "shared-update"
                && (entry.status === "conflict" || entry.status === "rejected")
              ))) {
                throw new Error("Resuelve primero la actualización pendiente antes de cancelar el evento.");
              }
              const nextEvents = events.filter((event) => event.id !== operation.eventId);
              snapshots.put({ userId, events: nextEvents, savedAt: new Date().toISOString() } satisfies CalendarSnapshot);
              operations.add(queuedOperation);
            } catch (error) {
              transaction.abort();
              reject(error);
            }
          };
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la cancelación pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar la cancelación pendiente."));
    });
  } finally {
    database.close();
  }
}

export async function markCalendarOperationAttempt(userId: string, operationId: string): Promise<void> {
  await updateCalendarOperation(userId, operationId, (operation) => {
    if (operation.kind === "save" && (operation.scope === "shared" || operation.scope === "shared-update")) {
      operation.attempted = true;
      operation.lastError = undefined;
    }
  });
}

export async function deleteLocalSharedDraft(
  userId: string,
  eventId: string,
  operationId: string,
): Promise<void> {
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const snapshotRequest = snapshots.get(userId);
      const operationsRequest = operations.index("userId").getAll(userId);
      let snapshot: CalendarSnapshot | undefined;
      let userOperations: CalendarOutboxOperation[] | undefined;
      let snapshotLoaded = false;
      let operationsLoaded = false;
      const finish = () => {
        if (!snapshotLoaded || !operationsLoaded) return;
        try {
          if (!snapshot || !userOperations) {
            throw new Error("No se encontró el borrador local de esta cuenta.");
          }
          const draft = userOperations.find((operation) => (
            operation.operationId === operationId
            && operation.eventId === eventId
            && operation.kind === "save"
            && operation.scope === "shared"
          ));
          if (!draft || (draft.kind === "save" && draft.status === "pending" && draft.attempted)) {
            throw new Error("No se puede eliminar un borrador mientras su sincronización está pendiente de confirmación.");
          }
          if (userOperations.some((operation) => (
            operation.eventId === eventId
            && operation.kind === "save"
            && operation.scope === "shared"
            && operation.status === "pending"
            && operation.attempted
          ))) {
            throw new Error("No se puede eliminar un borrador mientras su sincronización está pendiente de confirmación.");
          }
          const events = ensureSnapshotEvents(snapshot, userId);
          const localEvent = events.find((event) => event.id === eventId);
          if (!localEvent || localEvent.createdBy.id !== userId) {
            throw new Error("No se encontró el borrador local de esta cuenta.");
          }
          snapshots.put({
            userId,
            events: events.filter((event) => event.id !== eventId),
            savedAt: new Date().toISOString(),
          } satisfies CalendarSnapshot);
          userOperations
            .filter((operation) => operation.eventId === eventId)
            .forEach((operation) => operations.delete([userId, operation.operationId]));
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
      snapshotRequest.onsuccess = () => {
        snapshot = snapshotRequest.result as CalendarSnapshot | undefined;
        snapshotLoaded = true;
        finish();
      };
      operationsRequest.onsuccess = () => {
        userOperations = operationsRequest.result as CalendarOutboxOperation[];
        operationsLoaded = true;
        finish();
      };
      snapshotRequest.onerror = () => reject(snapshotRequest.error ?? new Error("No se pudo leer el borrador local."));
      operationsRequest.onerror = () => reject(operationsRequest.error ?? new Error("No se pudo leer el borrador local."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo eliminar el borrador local."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo eliminar el borrador local."));
    });
  } finally {
    database.close();
  }
}

export async function markCalendarOperationProblem(
  userId: string,
  operationId: string,
  status: "conflict" | "rejected",
  code: string,
): Promise<void> {
  await updateCalendarOperation(userId, operationId, (operation, snapshots) => {
    operation.status = status;
    operation.code = code;
    operation.lastError = undefined;
    if (operation.kind === "cancel") {
      const snapshotRequest = snapshots.get(userId);
      snapshotRequest.onsuccess = () => {
        const snapshot = snapshotRequest.result as CalendarSnapshot | undefined;
        const events = ensureSnapshotEvents(snapshot, userId);
        if (!events.some((event) => event.id === operation.eventId)) {
          events.push(operation.eventSnapshot);
        }
        snapshots.put({ userId, events, savedAt: new Date().toISOString() } satisfies CalendarSnapshot);
      };
    }
  });
}

export async function markCalendarOperationError(
  userId: string,
  operationId: string,
  message: string,
): Promise<void> {
  await updateCalendarOperation(userId, operationId, (operation) => {
    operation.lastError = message;
  });
}

async function updateCalendarOperation(
  userId: string,
  operationId: string,
  update: (operation: CalendarOutboxOperation, snapshots: IDBObjectStore) => void,
): Promise<void> {
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      const request = operations.get([userId, operationId]);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          reject(new Error("La operación pendiente ya no está disponible."));
          return;
        }
        const operation = request.result as CalendarOutboxOperation;
        update(operation, snapshots);
        operations.put(operation);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo actualizar la operación pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo actualizar la operación pendiente."));
    });
  } finally {
    database.close();
  }
}

export async function completeCalendarOperation(
  userId: string,
  operation: CalendarOutboxOperation,
  version?: number,
  resolvesOperationId: string | null = null,
): Promise<void> {
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const operations = transaction.objectStore(OPERATIONS_STORE);
      let confirmedEvent: CalendarEvent | undefined;
      const snapshotRequest = snapshots.get(userId);
      snapshotRequest.onsuccess = () => {
        const snapshot = snapshotRequest.result as CalendarSnapshot | undefined;
        const events = ensureSnapshotEvents(snapshot, userId);
        if (operation.kind === "cancel") {
          const nextEvents = events.filter((event) => event.id !== operation.eventId);
          snapshots.put({ userId, events: nextEvents, savedAt: new Date().toISOString() } satisfies CalendarSnapshot);
        } else if (typeof version === "number") {
          const nextEvents = events.map((event) => (
            event.id === operation.eventId && event.version < version
              ? { ...event, version }
              : event
          ));
          confirmedEvent = nextEvents.find((event) => event.id === operation.eventId);
          snapshots.put({ userId, events: nextEvents, savedAt: new Date().toISOString() } satisfies CalendarSnapshot);
        }
        operations.delete([userId, operation.operationId]);
        if (resolvesOperationId) operations.delete([userId, resolvesOperationId]);
        if (operation.kind === "save" && operation.supersedesOperationId) {
          operations.delete([userId, operation.supersedesOperationId]);
        }
      };
      const operationsRequest = operations.index("userId").getAll(userId);
      operationsRequest.onsuccess = () => {
        (operationsRequest.result as CalendarOutboxOperation[])
          .filter((entry) => entry.eventId === operation.eventId)
          .forEach((entry) => {
            if (
              operation.kind === "save"
              && operation.scope === "shared-update"
              && entry.kind === "cancel"
              && entry.scope === "shared"
              && entry.status === "pending"
              && typeof version === "number"
              && confirmedEvent
            ) {
              const hasEarlierPendingUpdate = (operationsRequest.result as CalendarOutboxOperation[])
                .some((candidate) => (
                  candidate.kind === "save"
                  && candidate.scope === "shared-update"
                  && candidate.eventId === operation.eventId
                  && candidate.status === "pending"
                  && candidate.input.expectedVersion < entry.expectedVersion
                ));
              if (!hasEarlierPendingUpdate) {
                entry.expectedVersion = version;
                entry.eventSnapshot = { ...confirmedEvent, version };
                operations.put(entry);
              }
            }
            if (
              entry.status === "rejected"
              || (operation.kind === "save"
                && operation.scope === "shared-update"
                && entry.kind === "save"
                && entry.scope === "shared-update"
                && entry.status === "conflict")
            ) {
              operations.delete([userId, entry.operationId]);
            }
          });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo finalizar la operación sincronizada."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo finalizar la operación sincronizada."));
    });
  } finally {
    database.close();
  }
}

export async function removeResolvedCalendarOperation(userId: string, operationId: string): Promise<void> {
  const database = await openCalendarCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      transaction.objectStore(OPERATIONS_STORE).delete([userId, operationId]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo cerrar el conflicto resuelto."));
      transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo cerrar el conflicto resuelto."));
    });
  } finally {
    database.close();
  }
}

export function mergeCalendarEventsWithOutbox(
  userId: string,
  serverEvents: CalendarEvent[],
  cachedEvents: CalendarEvent[],
  operations: CalendarOutboxOperation[],
): CalendarEvent[] {
  const events = new Map(
    serverEvents
      .filter((event) => isCalendarEventForUser(event, userId))
      .map((event) => [event.id, event]),
  );
  const cachedById = new Map(cachedEvents.map((event) => [event.id, event]));

  [...operations]
    .sort((left, right) => {
      if (left.eventId === right.eventId) {
        const leftVersion = left.kind === "save" ? left.input.expectedVersion : left.expectedVersion;
        const rightVersion = right.kind === "save" ? right.input.expectedVersion : right.expectedVersion;
        if (leftVersion !== rightVersion) return leftVersion - rightVersion;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })
    .forEach((operation) => {
      if (operation.kind === "cancel") {
        if (operation.status === "pending") {
          if (operation.scope === "shared") {
            const localEvent = cachedById.get(operation.eventId) ?? operation.eventSnapshot;
            if (isCalendarEventForUser(localEvent, userId)) {
              events.set(operation.eventId, localEvent);
            }
          } else {
            events.delete(operation.eventId);
          }
        } else if (!events.has(operation.eventId)) {
          events.set(operation.eventId, operation.eventSnapshot);
        }
        return;
      }

      if (operation.status !== "pending") {
        if (
          operation.input.expectedVersion === 0
          || operation.scope === "shared-update"
        ) {
          const localEvent = cachedById.get(operation.eventId) ?? operation.eventSnapshot;
          if (isCalendarEventForUser(localEvent, userId)) {
            events.set(operation.eventId, localEvent);
          }
        }
        return;
      }

      const localEvent = cachedById.get(operation.eventId) ?? operation.eventSnapshot;
      if (isCalendarEventForUser(localEvent, userId)) {
        events.set(operation.eventId, localEvent);
      }
    });

  return [...events.values()].sort((left, right) =>
    left.date.localeCompare(right.date) || left.startTime.localeCompare(right.startTime),
  );
}
