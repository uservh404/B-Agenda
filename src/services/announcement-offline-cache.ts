import type { Announcement, AnnouncementInput } from "./announcements";

const DATABASE_NAME = "agenda-juventud-announcement-cache";
const DATABASE_VERSION = 2;
const SNAPSHOTS_STORE = "snapshots";
const OPERATIONS_STORE = "operations";
const METADATA_STORE = "metadata";
const LEGACY_OPERATIONS_MIGRATED_KEY = "legacy-pending-operations-locked";

export interface AnnouncementCacheIdentity {
  projectId: string;
  userId: string;
  scope: string;
}

export type AnnouncementOperationStatus = "pending" | "conflict" | "rejected";
export type AnnouncementOperationKind = "create" | "update" | "delete";

export interface AnnouncementOperation {
  scope: string;
  projectId: string;
  userId: string;
  operationId: string;
  announcementId: string;
  kind: AnnouncementOperationKind;
  expectedVersion: number;
  input?: AnnouncementInput;
  previousAnnouncement: Announcement | null;
  status: AnnouncementOperationStatus;
  createdAt: string;
  attempts: number;
  code?: string;
  lastError?: string;
  authorizationRejected?: boolean;
}

interface AnnouncementSnapshot {
  scope: string;
  projectId: string;
  userId: string;
  announcements: Announcement[];
  savedAt: string | null;
  canPublishAnnouncements: boolean | null;
}

export interface AnnouncementCacheBundle {
  announcements: Announcement[] | null;
  savedAt: string | null;
  operations: AnnouncementOperation[];
  canPublishAnnouncements: boolean | null;
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("El almacenamiento local de Anuncios no está disponible."));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        database.createObjectStore(SNAPSHOTS_STORE, { keyPath: "scope" });
      }
      if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
        const store = database.createObjectStore(OPERATIONS_STORE, { keyPath: ["scope", "operationId"] });
        store.createIndex("scope", "scope", { unique: false });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      const transaction = database.transaction([OPERATIONS_STORE, METADATA_STORE], "readwrite");
      const metadataStore = transaction.objectStore(METADATA_STORE);
      const migrationMarker = metadataStore.get(LEGACY_OPERATIONS_MIGRATED_KEY);
      migrationMarker.onsuccess = () => {
        if (migrationMarker.result?.value === true) return;
        const cursorRequest = transaction.objectStore(OPERATIONS_STORE).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const operation = cursor.value as Partial<AnnouncementOperation>;
            if (operation.status === "pending") {
              // Versiones anteriores no distinguían operaciones no enviadas de solicitudes inciertas.
              const previousAttempts = typeof operation.attempts === "number"
                && Number.isSafeInteger(operation.attempts)
                ? operation.attempts
                : 0;
              cursor.update({ ...operation, attempts: Math.max(previousAttempts, 1) });
            }
            cursor.continue();
            return;
          }
          metadataStore.put({ key: LEGACY_OPERATIONS_MIGRATED_KEY, value: true });
        };
      };
      transaction.oncomplete = () => resolve(database);
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("No se pudo asegurar la cola local de Anuncios."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("La actualización de la cola local de Anuncios fue cancelada."));
      };
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir la caché local de Anuncios."));
    request.onblocked = () => reject(new Error("La caché local de Anuncios está bloqueada."));
  });
}

export function getAnnouncementCacheIdentity(userId: string): AnnouncementCacheIdentity {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!userId || !configuredUrl) {
    throw new Error("No se pudo determinar la cuenta y el proyecto para guardar Anuncios.");
  }
  let projectId: string;
  try {
    projectId = new URL(configuredUrl).host.toLowerCase();
  } catch {
    throw new Error("La configuración del proyecto para el almacenamiento local no es válida.");
  }
  return { projectId, userId, scope: `${projectId}:${userId}` };
}

function isAnnouncement(value: unknown): value is Announcement {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Announcement>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.content === "string"
    && typeof item.category === "string"
    && (item.authorId === null || typeof item.authorId === "string")
    && typeof item.authorName === "string"
    && typeof item.version === "number"
    && Number.isSafeInteger(item.version)
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string";
}

function isOperation(value: unknown, identity: AnnouncementCacheIdentity): value is AnnouncementOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<AnnouncementOperation>;
  return operation.scope === identity.scope
    && operation.projectId === identity.projectId
    && operation.userId === identity.userId
    && typeof operation.operationId === "string"
    && typeof operation.announcementId === "string"
    && (operation.kind === "create" || operation.kind === "update" || operation.kind === "delete")
    && typeof operation.expectedVersion === "number"
    && Number.isSafeInteger(operation.expectedVersion)
    && (operation.status === "pending" || operation.status === "conflict" || operation.status === "rejected")
    && typeof operation.createdAt === "string"
    && typeof operation.attempts === "number"
    && Number.isSafeInteger(operation.attempts)
    && (operation.authorizationRejected === undefined
      || typeof operation.authorizationRejected === "boolean")
    && (operation.kind === "delete"
      ? operation.input === undefined && isAnnouncement(operation.previousAnnouncement)
      : !!operation.input
        && typeof operation.input.title === "string"
        && typeof operation.input.content === "string"
        && typeof operation.input.category === "string");
}

export async function readAnnouncementCache(identity: AnnouncementCacheIdentity): Promise<AnnouncementCacheBundle> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readonly");
      const snapshotRequest = transaction.objectStore(SNAPSHOTS_STORE).get(identity.scope);
      const operationsRequest = transaction.objectStore(OPERATIONS_STORE).index("scope").getAll(identity.scope);
      transaction.oncomplete = () => {
        const stored = snapshotRequest.result as AnnouncementSnapshot | undefined;
        if (stored && (
          stored.projectId !== identity.projectId
          || stored.userId !== identity.userId
          || !Array.isArray(stored.announcements)
          || !stored.announcements.every(isAnnouncement)
          || (stored.savedAt !== null && typeof stored.savedAt !== "string")
        )) {
          reject(new Error("Los anuncios guardados no corresponden a esta cuenta y proyecto."));
          return;
        }
        const operations = (operationsRequest.result as unknown[])
          .filter((item) => isOperation(item, identity))
          .sort((first, second) =>
            first.createdAt.localeCompare(second.createdAt)
            || first.operationId.localeCompare(second.operationId),
          );
        resolve({
          announcements: stored?.announcements ?? null,
          savedAt: stored?.savedAt ?? null,
          operations,
          canPublishAnnouncements: stored?.canPublishAnnouncements ?? null,
        });
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron leer los anuncios locales."));
      transaction.onabort = () => reject(transaction.error ?? new Error("La lectura local de Anuncios fue cancelada."));
    });
  } finally {
    database.close();
  }
}

export async function saveAnnouncementSnapshot(
  identity: AnnouncementCacheIdentity,
  announcements: Announcement[],
  savedAt: string | null = new Date().toISOString(),
  canPublishAnnouncements?: boolean,
) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
      const store = transaction.objectStore(SNAPSHOTS_STORE);
      const request = store.get(identity.scope);
      request.onsuccess = () => {
        const previous = request.result as AnnouncementSnapshot | undefined;
        store.put({
          scope: identity.scope,
          projectId: identity.projectId,
          userId: identity.userId,
          announcements,
          savedAt,
          canPublishAnnouncements: canPublishAnnouncements
            ?? previous?.canPublishAnnouncements
            ?? null,
        } satisfies AnnouncementSnapshot);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la copia local de Anuncios."));
      transaction.onabort = () => reject(transaction.error ?? new Error("El guardado local de Anuncios fue cancelado."));
    });
  } finally {
    database.close();
  }
}

export async function enqueueAnnouncementOperation(
  identity: AnnouncementCacheIdentity,
  draft: Omit<AnnouncementOperation, "scope" | "projectId" | "userId" | "status" | "createdAt" | "attempts">,
) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.index("scope").getAll(identity.scope);
      request.onsuccess = () => {
        const operations = (request.result as unknown[])
          .filter((item) => isOperation(item, identity));
        const existing = operations
          .filter((operation) =>
            operation.announcementId === draft.announcementId
            && operation.status === "pending"
            && operation.attempts === 0,
          )
          .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0];
        if (existing) {
          if (draft.kind === "delete" && existing.kind === "create") {
            store.delete([identity.scope, existing.operationId]);
            return;
          }
          if (draft.kind === "delete" && existing.kind === "update") {
            store.put({
              ...existing,
              kind: "delete",
              expectedVersion: draft.expectedVersion,
              input: undefined,
              previousAnnouncement: draft.previousAnnouncement,
            });
            return;
          }
          if (
            existing.kind === "create"
            && (draft.kind === "create" || draft.kind === "update")
            && draft.input
          ) {
            store.put({ ...existing, input: draft.input });
            return;
          }
          if (existing.kind === "update" && draft.kind === "update" && draft.input) {
            store.put({ ...existing, input: draft.input });
            return;
          }
        }
        const latestCreatedAt = operations.reduce((latest, operation) => {
          const timestamp = Date.parse(operation.createdAt);
          return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
        }, 0);
        store.add({
          ...draft,
          scope: identity.scope,
          projectId: identity.projectId,
          userId: identity.userId,
          status: "pending",
          createdAt: new Date(Math.max(Date.now(), latestCreatedAt + 1)).toISOString(),
          attempts: 0,
        } satisfies AnnouncementOperation);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la operación pendiente."));
      transaction.onabort = () => reject(transaction.error ?? new Error("El guardado de la operación pendiente fue cancelado."));
    });
  } finally {
    database.close();
  }
}

export async function markAnnouncementOperationAttempted(
  identity: AnnouncementCacheIdentity,
  operationId: string,
): Promise<AnnouncementOperation | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      let attempted: AnnouncementOperation | null = null;
      request.onsuccess = () => {
        const operation = request.result as AnnouncementOperation | undefined;
        if (
          !operation
          || operation.userId !== identity.userId
          || operation.projectId !== identity.projectId
          || operation.status !== "pending"
        ) return;
        attempted = { ...operation, attempts: operation.attempts + 1 };
        store.put(attempted);
      };
      transaction.oncomplete = () => resolve(attempted);
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo preparar la operación de Anuncios."));
      transaction.onabort = () => reject(transaction.error ?? new Error("La preparación de la operación fue cancelada."));
    });
  } finally {
    database.close();
  }
}

export async function completeAnnouncementOperation(
  identity: AnnouncementCacheIdentity,
  operationId: string,
  confirmedVersion: number,
): Promise<AnnouncementOperation | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.index("scope").getAll(identity.scope);
      let rebasedOperation: AnnouncementOperation | null = null;
      request.onsuccess = () => {
        const operations = (request.result as unknown[])
          .filter((item) => isOperation(item, identity))
          .sort((first, second) =>
            first.createdAt.localeCompare(second.createdAt)
            || first.operationId.localeCompare(second.operationId),
          );
        const completed = operations.find((operation) => operation.operationId === operationId);
        if (!completed) return;
        store.delete([identity.scope, operationId]);
        if (completed.kind === "delete" || !completed.input) return;

        const successor = operations.find((operation) =>
          operation.announcementId === completed.announcementId
          && operation.operationId !== completed.operationId
          && operation.createdAt > completed.createdAt
          && operation.status === "pending"
          && operation.attempts === 0
          && (operation.kind === "update" || operation.kind === "delete"),
        );
        if (!successor) return;

        const base = completed.previousAnnouncement;
        const confirmedAnnouncement: Announcement = {
          id: completed.announcementId,
          title: completed.input.title,
          content: completed.input.content,
          category: completed.input.category,
          authorId: base ? base.authorId : completed.userId,
          authorName: base?.authorName ?? "Pendiente de confirmación",
          version: confirmedVersion,
          createdAt: base?.createdAt ?? completed.createdAt,
          updatedAt: completed.createdAt,
        };
        rebasedOperation = {
          ...successor,
          expectedVersion: confirmedVersion,
          previousAnnouncement: confirmedAnnouncement,
        };
        store.put(rebasedOperation);
      };
      transaction.oncomplete = () => resolve(rebasedOperation);
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo completar la operación de Anuncios."));
      transaction.onabort = () => reject(transaction.error ?? new Error("La operación de Anuncios fue cancelada."));
    });
  } finally {
    database.close();
  }
}

export async function updateAnnouncementOperation(
  identity: AnnouncementCacheIdentity,
  operationId: string,
  update: Pick<AnnouncementOperation, "status" | "code" | "lastError">
    & Partial<Pick<AnnouncementOperation, "authorizationRejected">>,
) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      request.onsuccess = () => {
        const operation = request.result as AnnouncementOperation | undefined;
        if (!operation || operation.userId !== identity.userId || operation.projectId !== identity.projectId) return;
        store.put({ ...operation, ...update });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo actualizar el estado de la operación."));
      transaction.onabort = () => reject(transaction.error ?? new Error("La actualización de la operación fue cancelada."));
    });
  } finally {
    database.close();
  }
}

export async function resetRejectedAnnouncementOperationForRetry(
  identity: AnnouncementCacheIdentity,
  operationId: string,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      let updateError: Error | null = null;
      request.onsuccess = () => {
        const operation = request.result as unknown;
        if (
          !isOperation(operation, identity)
          || operation.status !== "rejected"
          || operation.code !== "not_authorized"
          || operation.authorizationRejected === true
        ) {
          updateError = new Error("La operación no está lista para reanudarse con el mismo identificador.");
          transaction.abort();
          return;
        }
        store.put({
          ...operation,
          status: "pending",
          code: undefined,
          lastError: undefined,
        });
      };
      request.onerror = () => {
        updateError = request.error ?? new Error("No se pudo leer la operación rechazada.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        updateError ?? transaction.error ?? new Error("No se pudo reanudar la operación de Anuncios."),
      );
      transaction.onabort = () => reject(
        updateError ?? transaction.error ?? new Error("La reanudación de la operación fue cancelada."),
      );
    });
  } finally {
    database.close();
  }
}

export async function requeueRejectedAnnouncementOperation(
  identity: AnnouncementCacheIdentity,
  operationId: string,
): Promise<AnnouncementOperation> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      let replacement: AnnouncementOperation | null = null;
      let updateError: Error | null = null;

      request.onsuccess = () => {
        const operation = request.result as unknown;
        if (
          !isOperation(operation, identity)
          || operation.status !== "rejected"
          || operation.code !== "not_authorized"
          || operation.authorizationRejected !== true
        ) {
          updateError = new Error("Solo se pueden reanudar operaciones rechazadas por permisos.");
          transaction.abort();
          return;
        }

        try {
          replacement = {
            ...operation,
            operationId: crypto.randomUUID(),
            status: "pending",
            attempts: 0,
            code: undefined,
            lastError: undefined,
          };
          store.delete([identity.scope, operationId]);
          store.add(replacement);
        } catch (error) {
          updateError = error instanceof Error
            ? error
            : new Error("No se pudo preparar nuevamente la operación de Anuncios.");
          transaction.abort();
        }
      };
      request.onerror = () => {
        updateError = request.error ?? new Error("No se pudo leer la operación rechazada.");
        transaction.abort();
      };
      transaction.oncomplete = () => {
        if (replacement) resolve(replacement);
        else reject(new Error("La operación rechazada ya no está disponible."));
      };
      transaction.onerror = () => reject(
        updateError ?? transaction.error ?? new Error("No se pudo reanudar la operación de Anuncios."),
      );
      transaction.onabort = () => reject(
        updateError ?? transaction.error ?? new Error("La operación de Anuncios fue cancelada."),
      );
    });
  } finally {
    database.close();
  }
}

export function mergeAnnouncementsWithOutbox(
  snapshot: Announcement[],
  operations: AnnouncementOperation[],
): Announcement[] {
  const visible = new Map(snapshot.map((announcement) => [announcement.id, announcement]));
  for (const operation of operations) {
    if (operation.kind === "delete") {
      visible.delete(operation.announcementId);
    } else if (operation.input) {
      const base = operation.previousAnnouncement;
      visible.set(operation.announcementId, {
        id: operation.announcementId,
        title: operation.input.title,
        content: operation.input.content,
        category: operation.input.category,
        authorId: base ? base.authorId : operation.userId,
        authorName: base?.authorName ?? "Pendiente de confirmación",
        version: base?.version ?? 1,
        createdAt: base?.createdAt ?? operation.createdAt,
        updatedAt: operation.createdAt,
      });
    }
  }
  return [...visible.values()].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt) || first.title.localeCompare(second.title, "es"),
  );
}
