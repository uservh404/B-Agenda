import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  hasConfirmedAccountSuspension,
  isAccountSuspensionConfirmedInSession,
  notifyConfirmedAccountSuspension,
} from "../auth/account-suspension-response";
import { supabase } from "../lib/supabaseClient";
import {
  getAnnouncementCacheIdentity,
  type AnnouncementCacheIdentity,
} from "./announcement-offline-cache";
import { checkOfflineSyncAccount } from "./offline-sync-authorization";

const DATABASE_NAME = "agenda-juventud-announcement-read-state-sync";
const DATABASE_VERSION = 1;
const REMOTE_STATES_STORE = "remote-states";
const PENDING_STATES_STORE = "pending-states";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AnnouncementReadStateSnapshot {
  source: "remote" | "offline-cache";
  readVersions: Record<string, number>;
  pendingVersions: Record<string, number>;
  savedAt: string | null;
}

export interface AnnouncementReadStateSyncIssue {
  announcementId: string;
  version: number;
  message: string;
}

export interface AnnouncementReadStateFlushResult {
  status: "complete" | "offline" | "blocked" | "partial";
  synced: Array<{ announcementId: string; version: number }>;
  stale: Array<{ announcementId: string; version: number }>;
  issues: AnnouncementReadStateSyncIssue[];
  pendingCount: number;
  reason?: string;
}

export type MarkAnnouncementReadResult =
  | { status: "synced"; announcementId: string; version: number }
  | { status: "stale"; announcementId: string; version: number }
  | { status: "queued"; announcementId: string; version: number; reason: string };

type PendingReadState = {
  scope: string;
  projectId: string;
  userId: string;
  announcementId: string;
  version: number;
  createdAt: string;
  attempts: number;
};

type StoredRemoteStates = {
  scope: string;
  projectId: string;
  userId: string;
  readVersions: Record<string, number>;
  savedAt: string;
};

type PersistedReadStates = {
  readVersions: Record<string, number>;
  pending: PendingReadState[];
  savedAt: string | null;
};

type AccountGate =
  | { allowed: true }
  | {
    allowed: false;
    status: "offline" | "suspended" | "forbidden" | "unavailable";
    message: string;
  };

let subscriptionSequence = 0;
const activeReadStateFlushes = new Map<string, Promise<AnnouncementReadStateFlushResult>>();

function isReadVersion(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1;
}

function parseReadVersion(value: unknown): number {
  if (isReadVersion(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (isReadVersion(parsed)) return parsed;
  }
  throw new Error("Supabase devolvió una versión de lectura no válida.");
}

function validateIdentity(identity: AnnouncementCacheIdentity): AnnouncementCacheIdentity {
  if (
    !identity
    || !UUID_PATTERN.test(identity.userId)
    || !identity.projectId
    || !identity.scope
  ) {
    throw new Error("La identidad de la cuenta para lecturas de Anuncios no es válida.");
  }
  const expected = getAnnouncementCacheIdentity(identity.userId);
  if (identity.projectId !== expected.projectId || identity.scope !== expected.scope) {
    throw new Error("La identidad de lecturas no corresponde al proyecto y cuenta actuales.");
  }
  return identity;
}

function validateVersionMap(value: Readonly<Record<string, number>>): void {
  for (const [announcementId, version] of Object.entries(value)) {
    if (!UUID_PATTERN.test(announcementId) || !isReadVersion(version)) {
      throw new Error("El estado local de lecturas contiene datos no válidos.");
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(
      new Error("El almacenamiento separado de lecturas pendientes no está disponible."),
    );
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REMOTE_STATES_STORE)) {
        database.createObjectStore(REMOTE_STATES_STORE, { keyPath: "scope" });
      }
      if (!database.objectStoreNames.contains(PENDING_STATES_STORE)) {
        const store = database.createObjectStore(
          PENDING_STATES_STORE,
          { keyPath: ["scope", "announcementId"] },
        );
        store.createIndex("scope", "scope", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(
      request.error ?? new Error("No se pudo abrir el almacenamiento de lecturas de Anuncios."),
    );
    request.onblocked = () => reject(
      new Error("El almacenamiento separado de lecturas de Anuncios está bloqueado."),
    );
  });
}

function isStoredRemoteStates(
  value: unknown,
  identity: AnnouncementCacheIdentity,
): value is StoredRemoteStates {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<StoredRemoteStates>;
  if (
    stored.scope !== identity.scope
    || stored.projectId !== identity.projectId
    || stored.userId !== identity.userId
    || typeof stored.savedAt !== "string"
    || !stored.readVersions
    || typeof stored.readVersions !== "object"
    || Array.isArray(stored.readVersions)
  ) {
    return false;
  }
  return Object.entries(stored.readVersions).every(([announcementId, version]) =>
    UUID_PATTERN.test(announcementId) && isReadVersion(version),
  );
}

function isPendingReadState(
  value: unknown,
  identity: AnnouncementCacheIdentity,
): value is PendingReadState {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingReadState>;
  return pending.scope === identity.scope
    && pending.projectId === identity.projectId
    && pending.userId === identity.userId
    && typeof pending.announcementId === "string"
    && UUID_PATTERN.test(pending.announcementId)
    && isReadVersion(pending.version)
    && typeof pending.createdAt === "string"
    && Number.isFinite(Date.parse(pending.createdAt))
    && typeof pending.attempts === "number"
    && Number.isSafeInteger(pending.attempts)
    && pending.attempts >= 0;
}

async function readPersistedStates(
  identity: AnnouncementCacheIdentity,
): Promise<PersistedReadStates> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [REMOTE_STATES_STORE, PENDING_STATES_STORE],
        "readonly",
      );
      const remoteRequest = transaction.objectStore(REMOTE_STATES_STORE).get(identity.scope);
      const pendingRequest = transaction
        .objectStore(PENDING_STATES_STORE)
        .index("scope")
        .getAll(identity.scope);

      transaction.oncomplete = () => {
        try {
          const stored = remoteRequest.result as unknown;
          if (stored !== undefined && !isStoredRemoteStates(stored, identity)) {
            throw new Error("La caché remota de lecturas no corresponde a esta cuenta y proyecto.");
          }
          const pendingRows = pendingRequest.result as unknown[];
          if (!pendingRows.every((item) => isPendingReadState(item, identity))) {
            throw new Error("La cola aislada de lecturas contiene datos no válidos.");
          }
          const pending = pendingRows as PendingReadState[];
          const remote = stored as StoredRemoteStates | undefined;
          resolve({
            readVersions: remote?.readVersions ?? {},
            pending,
            savedAt: remote?.savedAt ?? null,
          });
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo leer el estado local de lecturas."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("La lectura local de lecturas fue cancelada."),
      );
    });
  } finally {
    database.close();
  }
}

async function saveRemoteStates(
  identity: AnnouncementCacheIdentity,
  readVersions: Record<string, number>,
): Promise<void> {
  validateVersionMap(readVersions);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(REMOTE_STATES_STORE, "readwrite");
      transaction.objectStore(REMOTE_STATES_STORE).put({
        scope: identity.scope,
        projectId: identity.projectId,
        userId: identity.userId,
        readVersions,
        savedAt: new Date().toISOString(),
      } satisfies StoredRemoteStates);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo guardar la copia remota de lecturas."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("El guardado de la copia remota de lecturas fue cancelado."),
      );
    });
  } finally {
    database.close();
  }
}

export async function queueAnnouncementReadStates(
  rawIdentity: AnnouncementCacheIdentity,
  reads: ReadonlyArray<{ announcementId: string; version: number }>,
): Promise<void> {
  const identity = validateIdentity(rawIdentity);
  await assertCurrentSession(identity.userId);
  const requestedVersions = new Map<string, number>();
  for (const read of reads) {
    if (!UUID_PATTERN.test(read.announcementId) || !isReadVersion(read.version)) {
      throw new Error("Un anuncio o una versión de lectura pendiente no son válidos.");
    }
    requestedVersions.set(
      read.announcementId,
      Math.max(requestedVersions.get(read.announcementId) ?? 0, read.version),
    );
  }
  if (requestedVersions.size === 0) return;

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PENDING_STATES_STORE, "readwrite");
      const store = transaction.objectStore(PENDING_STATES_STORE);
      for (const [announcementId, version] of requestedVersions) {
        const request = store.get([identity.scope, announcementId]);
        request.onsuccess = () => {
          const existing = request.result as unknown;
          if (existing !== undefined && !isPendingReadState(existing, identity)) {
            transaction.abort();
            return;
          }
          const pending = existing as PendingReadState | undefined;
          store.put({
            scope: identity.scope,
            projectId: identity.projectId,
            userId: identity.userId,
            announcementId,
            version: Math.max(pending?.version ?? 0, version),
            createdAt: pending?.createdAt ?? new Date().toISOString(),
            attempts: pending?.attempts ?? 0,
          } satisfies PendingReadState);
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo guardar la lectura pendiente."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("El guardado de la lectura pendiente fue cancelado."),
      );
    });
  } finally {
    database.close();
  }
}

async function recordAttempt(
  identity: AnnouncementCacheIdentity,
  pending: PendingReadState,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PENDING_STATES_STORE, "readwrite");
      const store = transaction.objectStore(PENDING_STATES_STORE);
      const request = store.get([identity.scope, pending.announcementId]);
      request.onsuccess = () => {
        const current = request.result as unknown;
        if (
          !isPendingReadState(current, identity)
          || current.version !== pending.version
        ) return;
        store.put({ ...current, attempts: current.attempts + 1 });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo registrar el intento de lectura."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("El registro del intento de lectura fue cancelado."),
      );
    });
  } finally {
    database.close();
  }
}

async function removePendingReadState(
  identity: AnnouncementCacheIdentity,
  pending: PendingReadState,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PENDING_STATES_STORE, "readwrite");
      const store = transaction.objectStore(PENDING_STATES_STORE);
      const request = store.get([identity.scope, pending.announcementId]);
      request.onsuccess = () => {
        const current = request.result as unknown;
        if (
          isPendingReadState(current, identity)
          && current.version === pending.version
        ) {
          store.delete([identity.scope, pending.announcementId]);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error("No se pudo retirar la lectura pendiente."),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error("La limpieza de la lectura pendiente fue cancelada."),
      );
    });
  } finally {
    database.close();
  }
}

async function assertCurrentSession(userId: string): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session?.user.id !== userId) {
    throw new Error("La sesión actual no corresponde a la cuenta de lecturas de Anuncios.");
  }
  if (isAccountSuspensionConfirmedInSession(userId)) {
    throw new Error("account_suspended");
  }
}

async function checkActiveAccount(identity: AnnouncementCacheIdentity): Promise<AccountGate> {
  if (!window.navigator.onLine) {
    return { allowed: false, status: "offline", message: "Sin conexión." };
  }
  try {
    const account = await checkOfflineSyncAccount(identity.userId);
    if (account.status === "active") {
      await assertCurrentSession(identity.userId);
      return { allowed: true };
    }
    if (account.status === "suspended") {
      return { allowed: false, status: "suspended", message: "La cuenta está suspendida." };
    }
    if (account.status === "forbidden") {
      return { allowed: false, status: "forbidden", message: "La cuenta no tiene acceso a Anuncios." };
    }
    const accountError = account.status === "unavailable" ? account.error : null;
    return {
      allowed: false,
      status: "unavailable",
      message: accountError instanceof Error
        ? accountError.message
        : "No se pudo confirmar el estado de la cuenta.",
    };
  } catch (error) {
    return {
      allowed: false,
      status: hasConfirmedAccountSuspension(error) ? "suspended" : "unavailable",
      message: error instanceof Error
        ? error.message
        : "No se pudo confirmar el estado de la cuenta.",
    };
  }
}

function accountStatusFromGate(gate: AccountGate): AnnouncementReadStateFlushResult["status"] {
  if (gate.allowed) return "complete";
  if (gate.status === "offline") return "offline";
  if (gate.status === "unavailable") return "partial";
  return "blocked";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Error no identificado al sincronizar la lectura.";
}

function toPendingVersions(pending: PendingReadState[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const item of pending) {
    versions[item.announcementId] = Math.max(
      versions[item.announcementId] ?? 0,
      item.version,
    );
  }
  return versions;
}

export async function getCachedAnnouncementReadStateSnapshot(
  rawIdentity: AnnouncementCacheIdentity,
): Promise<AnnouncementReadStateSnapshot> {
  const identity = validateIdentity(rawIdentity);
  await assertCurrentSession(identity.userId);
  const persisted = await readPersistedStates(identity);
  return {
    source: "offline-cache",
    readVersions: persisted.readVersions,
    pendingVersions: toPendingVersions(persisted.pending),
    savedAt: persisted.savedAt,
  };
}

export async function getAnnouncementReadStateSnapshot(
  rawIdentity: AnnouncementCacheIdentity,
): Promise<AnnouncementReadStateSnapshot> {
  const identity = validateIdentity(rawIdentity);
  if (!window.navigator.onLine) {
    return getCachedAnnouncementReadStateSnapshot(identity);
  }
  const gate = await checkActiveAccount(identity);
  if (!gate.allowed) throw new Error(gate.message);

  const { data, error } = await supabase
    .from("announcement_read_states")
    .select("user_id, announcement_id, read_version")
    .eq("user_id", identity.userId);
  if (error) {
    if (hasConfirmedAccountSuspension(error)) {
      notifyConfirmedAccountSuspension(identity.userId);
    }
    throw error;
  }
  await assertCurrentSession(identity.userId);
  if (!Array.isArray(data)) {
    throw new Error("Supabase devolvió una lista de lecturas no válida.");
  }

  const readVersions: Record<string, number> = {};
  for (const value of data as unknown[]) {
    if (!value || typeof value !== "object") {
      throw new Error("Supabase devolvió un estado de lectura no válido.");
    }
    const row = value as {
      user_id?: unknown;
      announcement_id?: unknown;
      read_version?: unknown;
    };
    if (
      row.user_id !== identity.userId
      || typeof row.announcement_id !== "string"
      || !UUID_PATTERN.test(row.announcement_id)
    ) {
      throw new Error("Supabase devolvió una lectura fuera del alcance de la cuenta actual.");
    }
    const version = parseReadVersion(row.read_version);
    readVersions[row.announcement_id] = Math.max(
      readVersions[row.announcement_id] ?? 0,
      version,
    );
  }

  await saveRemoteStates(identity, readVersions);
  const persisted = await readPersistedStates(identity);
  return {
    source: "remote",
    readVersions,
    pendingVersions: toPendingVersions(persisted.pending),
    savedAt: persisted.savedAt,
  };
}

export function reconcileAnnouncementReadVersions(
  currentVersions: Readonly<Record<string, number>>,
  remoteReadVersions: Readonly<Record<string, number>>,
  localReadVersions: Readonly<Record<string, number>>,
  pendingReadVersions: Readonly<Record<string, number>> = {},
): Record<string, number> {
  validateVersionMap(currentVersions);
  validateVersionMap(remoteReadVersions);
  validateVersionMap(localReadVersions);
  validateVersionMap(pendingReadVersions);

  const reconciled: Record<string, number> = {};
  for (const [announcementId, currentVersion] of Object.entries(currentVersions)) {
    const candidates = [
      remoteReadVersions[announcementId],
      localReadVersions[announcementId],
      pendingReadVersions[announcementId],
    ].filter((version): version is number =>
      isReadVersion(version) && version <= currentVersion,
    );
    if (candidates.length > 0) {
      reconciled[announcementId] = Math.max(...candidates);
    }
  }
  return reconciled;
}

async function flushPendingAnnouncementReadStatesInternal(
  identity: AnnouncementCacheIdentity,
): Promise<AnnouncementReadStateFlushResult> {
  await assertCurrentSession(identity.userId);
  const persisted = await readPersistedStates(identity);
  const result: AnnouncementReadStateFlushResult = {
    status: "complete",
    synced: [],
    stale: [],
    issues: [],
    pendingCount: persisted.pending.length,
  };
  if (persisted.pending.length === 0) return result;

  const gate = await checkActiveAccount(identity);
  if (!gate.allowed) {
    return {
      ...result,
      status: accountStatusFromGate(gate),
      reason: gate.message,
    };
  }

  for (const pending of persisted.pending) {
    if (!window.navigator.onLine) {
      result.status = "offline";
      result.reason = "La conexión se perdió; las lecturas pendientes se conservaron.";
      break;
    }
    try {
      await recordAttempt(identity, pending);
      await assertCurrentSession(identity.userId);
      const { data, error } = await supabase.rpc("mark_announcement_read_v1", {
        p_announcement_id: pending.announcementId,
        p_version: pending.version,
      });
      if (error) {
        result.issues.push({
          announcementId: pending.announcementId,
          version: pending.version,
          message: errorMessage(error),
        });
        if (hasConfirmedAccountSuspension(error)) {
          notifyConfirmedAccountSuspension(identity.userId);
          result.status = "blocked";
          result.reason = "La cuenta está suspendida.";
          break;
        }
        if (!window.navigator.onLine) {
          result.status = "offline";
          result.reason = "La conexión se perdió; las lecturas pendientes se conservaron.";
          break;
        }
        continue;
      }
      await assertCurrentSession(identity.userId);
      if (typeof data !== "boolean") {
        result.issues.push({
          announcementId: pending.announcementId,
          version: pending.version,
          message: "El RPC devolvió un resultado de lectura no válido.",
        });
        continue;
      }
      if (data) {
        const cached = await readPersistedStates(identity);
        await saveRemoteStates(identity, {
          ...cached.readVersions,
          [pending.announcementId]: Math.max(
            cached.readVersions[pending.announcementId] ?? 0,
            pending.version,
          ),
        });
        await removePendingReadState(identity, pending);
        result.synced.push({
          announcementId: pending.announcementId,
          version: pending.version,
        });
      } else {
        await removePendingReadState(identity, pending);
        result.stale.push({
          announcementId: pending.announcementId,
          version: pending.version,
        });
      }
    } catch (error) {
      result.issues.push({
        announcementId: pending.announcementId,
        version: pending.version,
        message: errorMessage(error),
      });
      if (hasConfirmedAccountSuspension(error)) {
        notifyConfirmedAccountSuspension(identity.userId);
        result.status = "blocked";
        result.reason = "La cuenta está suspendida.";
        break;
      }
      if (!window.navigator.onLine) {
        result.status = "offline";
        result.reason = "La conexión se perdió; las lecturas pendientes se conservaron.";
        break;
      }
    }
  }

  result.pendingCount = (await readPersistedStates(identity)).pending.length;
  if (result.issues.length > 0 && result.status === "complete") {
    result.status = "partial";
  }
  return result;
}

export async function flushPendingAnnouncementReadStates(
  rawIdentity: AnnouncementCacheIdentity,
): Promise<AnnouncementReadStateFlushResult> {
  const identity = validateIdentity(rawIdentity);
  const activeFlush = activeReadStateFlushes.get(identity.scope);
  if (activeFlush) return activeFlush;

  const flushPromise = flushPendingAnnouncementReadStatesInternal(identity);
  activeReadStateFlushes.set(identity.scope, flushPromise);
  void flushPromise.then(
    () => {
      if (activeReadStateFlushes.get(identity.scope) === flushPromise) {
        activeReadStateFlushes.delete(identity.scope);
      }
    },
    () => {
      if (activeReadStateFlushes.get(identity.scope) === flushPromise) {
        activeReadStateFlushes.delete(identity.scope);
      }
    },
  );
  return flushPromise;
}

export async function markAnnouncementVersionReadRemotely(
  rawIdentity: AnnouncementCacheIdentity,
  announcementId: string,
  version: number,
): Promise<MarkAnnouncementReadResult> {
  const identity = validateIdentity(rawIdentity);
  if (!UUID_PATTERN.test(announcementId) || !isReadVersion(version)) {
    throw new Error("El anuncio o la versión para marcar como leídos no son válidos.");
  }
  await queueAnnouncementReadStates(identity, [{ announcementId, version }]);
  if (!window.navigator.onLine) {
    return {
      status: "queued",
      announcementId,
      version,
      reason: "Sin conexión; la lectura quedó guardada para reintentar.",
    };
  }

  const flush = await flushPendingAnnouncementReadStates(identity);
  if (flush.synced.some((item) =>
    item.announcementId === announcementId && item.version >= version
  )) {
    return { status: "synced", announcementId, version };
  }
  if (flush.stale.some((item) => item.announcementId === announcementId)) {
    return { status: "stale", announcementId, version };
  }
  return {
    status: "queued",
    announcementId,
    version,
    reason: flush.issues.find((issue) => issue.announcementId === announcementId)?.message
      ?? flush.reason
      ?? "La lectura permanece pendiente de confirmación remota.",
  };
}

export function subscribeToAnnouncementReadStateChanges(
  rawIdentity: AnnouncementCacheIdentity,
  onChange: () => void,
  onStatus: (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): RealtimeChannel {
  const identity = validateIdentity(rawIdentity);
  return supabase
    .channel(`announcement-read-states:${identity.scope}:${++subscriptionSequence}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "announcement_read_states",
      filter: `user_id=eq.${identity.userId}`,
    }, onChange)
    .subscribe((status) => {
      if (
        status === "SUBSCRIBED"
        || status === "TIMED_OUT"
        || status === "CLOSED"
        || status === "CHANNEL_ERROR"
      ) {
        onStatus(status);
      }
    });
}

export function removeAnnouncementReadStateChangesSubscription(
  channel: RealtimeChannel,
) {
  return supabase.removeChannel(channel);
}
