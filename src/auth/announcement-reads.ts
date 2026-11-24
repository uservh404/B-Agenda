import {
  getAnnouncementCacheIdentity,
  readAnnouncementCache,
} from "../services/announcement-offline-cache";
import {
  flushPendingAnnouncementReadStates,
  getAnnouncementReadStateSnapshot,
  markAnnouncementVersionReadRemotely,
  queueAnnouncementReadStates,
  reconcileAnnouncementReadVersions,
} from "../services/announcement-read-state-sync";

const seenThroughStorageKey = "agenda-juventud-announcements-seen-through";
const readIdsStorageKey = "agenda-juventud-announcement-read-ids";
const readVersionsMigrationKey = "agenda-juventud-announcement-read-versions-migrated-v1";
const readVersionsStorageKey = "agenda-juventud-announcement-read-versions";
const announcementsUpdatedEvent = "agenda-juventud-announcements-updated";

function readSeenThrough(): Record<string, string> {
  try {
    const stored = window.localStorage.getItem(seenThroughStorageKey);
    if (!stored) return {};
    const value: unknown = JSON.parse(stored);
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

function readReadIds(): Record<string, string[]> {
  try {
    const stored = window.localStorage.getItem(readIdsStorageKey);
    if (!stored) return {};
    const value: unknown = JSON.parse(stored);
    return value && typeof value === "object"
      ? value as Record<string, string[]>
      : {};
  } catch {
    return {};
  }
}

function readReadVersions(): Record<string, Record<string, number>> {
  try {
    const stored = window.localStorage.getItem(readVersionsStorageKey);
    if (!stored) return {};
    const value: unknown = JSON.parse(stored);
    return value && typeof value === "object"
      ? value as Record<string, Record<string, number>>
      : {};
  } catch {
    return {};
  }
}

function isUnreadWithoutVersionState(createdAt: string, version: number, seenThrough: string) {
  return version > 1 || createdAt > seenThrough;
}

function migrateHistoricalReadIds(
  identity: ReturnType<typeof getAnnouncementCacheIdentity>,
  bundle: Awaited<ReturnType<typeof readAnnouncementCache>>,
): void {
  const readIds = new Set(readReadIds()[identity.scope] ?? []);
  if (readIds.size === 0) return;

  const migrations = readReadVersions()[identity.scope] ?? {};
  const byScopeMigrations = readReadVersions();
  const migratedScopes = (() => {
    try {
      const stored = window.localStorage.getItem(readVersionsMigrationKey);
      if (!stored) return {} as Record<string, boolean>;
      const value: unknown = JSON.parse(stored);
      return value && typeof value === "object"
        ? value as Record<string, boolean>
        : {};
    } catch {
      return {};
    }
  })();

  if (migratedScopes[identity.scope]) return;

  const nextVersions = { ...migrations };
  for (const announcement of bundle.announcements ?? []) {
    if (readIds.has(announcement.id) && nextVersions[announcement.id] === undefined) {
      nextVersions[announcement.id] = 1;
    }
  }

  window.localStorage.setItem(readVersionsStorageKey, JSON.stringify({
    ...byScopeMigrations,
    [identity.scope]: nextVersions,
  }));
  window.localStorage.setItem(readVersionsMigrationKey, JSON.stringify({
    ...migratedScopes,
    [identity.scope]: true,
  }));
}

function saveReadVersion(userId: string, announcementId: string, version: number) {
  if (!userId || !announcementId || !Number.isSafeInteger(version) || version < 1) return;
  const identity = getAnnouncementCacheIdentity(userId);
  const byScope = readReadVersions();
  const versions = byScope[identity.scope] ?? {};
  if ((versions[announcementId] ?? 0) >= version) return;
  window.localStorage.setItem(readVersionsStorageKey, JSON.stringify({
    ...byScope,
    [identity.scope]: { ...versions, [announcementId]: version },
  }));
  markAnnouncementAsRead(userId, announcementId);
}

export function markAnnouncementVersionAsRead(userId: string, announcementId: string, version: number) {
  saveReadVersion(userId, announcementId, version);
  window.dispatchEvent(new Event(announcementsUpdatedEvent));
  if (!userId || !announcementId || !Number.isSafeInteger(version) || version < 1) return;
  void markAnnouncementVersionReadRemotely(
    getAnnouncementCacheIdentity(userId),
    announcementId,
    version,
  ).then((result) => {
    if (result.status === "stale") {
      console.info("La versión cambió antes de confirmar la lectura; sigue pendiente de revisión.");
    } else if (result.status === "queued" && window.navigator.onLine) {
      console.warn("La lectura de Anuncios quedó pendiente de sincronización.", result.reason);
    }
  }).catch((error: unknown) => {
    console.error("No se pudo persistir remotamente la lectura de Anuncios.", error);
  });
}

// Call only with versions from a successfully confirmed server announcement snapshot.
export async function synchronizeRemoteAnnouncementReadVersions(
  userId: string,
  confirmedCurrentVersions: Readonly<Record<string, number>>,
): Promise<void> {
  if (!userId) return;
  const identity = getAnnouncementCacheIdentity(userId);
  const snapshot = await getAnnouncementReadStateSnapshot(identity);
  if (snapshot.source !== "remote") return;

  const currentVersions = { ...confirmedCurrentVersions };
  const storedVersions = readReadVersions();
  const localVersions = storedVersions[identity.scope] ?? {};
  const validLocalVersions = Object.fromEntries(
    Object.entries(localVersions).filter(([announcementId, version]) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(announcementId)
      && Number.isSafeInteger(version)
      && version >= 1,
    ),
  );
  const reconciled = reconcileAnnouncementReadVersions(
    currentVersions,
    snapshot.readVersions,
    validLocalVersions,
    snapshot.pendingVersions,
  );

  const nextVersions = { ...localVersions };
  let changed = false;
  for (const [announcementId, version] of Object.entries(reconciled)) {
    if (version > (localVersions[announcementId] ?? 0)) {
      nextVersions[announcementId] = version;
      changed = true;
    }
  }
  if (!changed) return;

  window.localStorage.setItem(readVersionsStorageKey, JSON.stringify({
    ...storedVersions,
    [identity.scope]: nextVersions,
  }));
  window.dispatchEvent(new Event(announcementsUpdatedEvent));
}

export async function getUnreadAnnouncementCount(userId: string): Promise<number> {
  if (!userId) return 0;
  const identity = getAnnouncementCacheIdentity(userId);
  const bundle = await readAnnouncementCache(identity);
  migrateHistoricalReadIds(identity, bundle);
  const readIds = new Set(readReadIds()[identity.scope] ?? []);
  const readVersions = readReadVersions()[identity.scope] ?? {};
  const seenThrough = readSeenThrough()[identity.scope] ?? "";
  for (const announcement of bundle.announcements ?? []) {
    if (readIds.has(announcement.id) && readVersions[announcement.id] === undefined) {
      saveReadVersion(userId, announcement.id, 1);
    }
  }
  const migratedReadVersions = readReadVersions()[identity.scope] ?? {};
  return (bundle.announcements ?? []).filter((announcement) =>
    (migratedReadVersions[announcement.id] !== undefined
      ? (migratedReadVersions[announcement.id] ?? 0) < announcement.version
      : !readIds.has(announcement.id)
        && isUnreadWithoutVersionState(announcement.createdAt, announcement.version, seenThrough)),
  ).length;
}

export function getReadAnnouncementIds(userId: string): string[] {
  if (!userId) return [];
  const identity = getAnnouncementCacheIdentity(userId);
  return readReadIds()[identity.scope] ?? [];
}

export function isAnnouncementUnread(userId: string, announcementId: string, createdAt: string, version = 1): boolean {
  if (!userId || !announcementId) return false;
  const identity = getAnnouncementCacheIdentity(userId);
  const readVersions = readReadVersions()[identity.scope] ?? {};
  if (readVersions[announcementId] !== undefined) {
    return (readVersions[announcementId] ?? 0) < version;
  }
  const readIds = readReadIds()[identity.scope] ?? [];
  if (readIds.includes(announcementId)) {
    saveReadVersion(userId, announcementId, 1);
    return 1 < version;
  }
  const seenThrough = readSeenThrough()[identity.scope] ?? "";
  return isUnreadWithoutVersionState(createdAt, version, seenThrough);
}

export function markAnnouncementAsRead(userId: string, announcementId: string) {
  if (!userId || !announcementId) return;
  const identity = getAnnouncementCacheIdentity(userId);
  const readIdsByScope = readReadIds();
  const readIds = new Set(readIdsByScope[identity.scope] ?? []);
  if (readIds.has(announcementId)) return;
  readIds.add(announcementId);
  window.localStorage.setItem(readIdsStorageKey, JSON.stringify({
    ...readIdsByScope,
    [identity.scope]: [...readIds],
  }));
  window.dispatchEvent(new Event(announcementsUpdatedEvent));
}

export function markAllAnnouncementsAsRead(
  userId: string,
  announcementIds: string[],
  versions?: Map<string, number>,
) {
  if (!userId) return;
  const identity = getAnnouncementCacheIdentity(userId);
  const readIdsByScope = readReadIds();
  const readIds = new Set(readIdsByScope[identity.scope] ?? []);
  const versionsByScope = readReadVersions();
  const readVersions = { ...(versionsByScope[identity.scope] ?? {}) };
  for (const announcementId of new Set(announcementIds)) {
    if (announcementId) readIds.add(announcementId);
    const version = versions?.get(announcementId);
    if (Number.isSafeInteger(version) && (version ?? 0) >= 1) {
      readVersions[announcementId] = Math.max(
        readVersions[announcementId] ?? 0,
        version as number,
      );
    }
  }
  window.localStorage.setItem(readIdsStorageKey, JSON.stringify({
    ...readIdsByScope,
    [identity.scope]: [...readIds],
  }));
  window.localStorage.setItem(readVersionsStorageKey, JSON.stringify({
    ...versionsByScope,
    [identity.scope]: readVersions,
  }));
  window.dispatchEvent(new Event(announcementsUpdatedEvent));

  const remoteReads: Array<{ announcementId: string; version: number }> = [];
  for (const announcementId of new Set(announcementIds)) {
    const version = versions?.get(announcementId);
    if (
      announcementId
      && typeof version === "number"
      && Number.isSafeInteger(version)
      && version >= 1
    ) {
      remoteReads.push({ announcementId, version });
    }
  }
  if (remoteReads.length > 0) {
    void queueAnnouncementReadStates(identity, remoteReads)
      .then(() => flushPendingAnnouncementReadStates(identity))
      .then((result) => {
        if (result.issues.length > 0) {
          console.error("Algunas lecturas de Anuncios siguen pendientes.", result.issues);
        } else if (result.reason && result.status !== "offline") {
          console.warn("Las lecturas de Anuncios no se sincronizaron.", result.reason);
        }
        if (result.stale.length > 0) {
          console.info("Algunas versiones cambiaron antes de confirmar su lectura.", result.stale);
        }
      })
      .catch((error: unknown) => {
        console.error("No se pudieron sincronizar todas las lecturas de Anuncios.", error);
      });
  }
}

export function markAnnouncementsAsSeen(userId: string, latestCreatedAt: string | null) {
  if (!userId || !latestCreatedAt) return;
  const identity = getAnnouncementCacheIdentity(userId);
  const seenThrough = readSeenThrough();
  const previous = seenThrough[identity.scope] ?? "";
  if (latestCreatedAt <= previous) return;
  window.localStorage.setItem(seenThroughStorageKey, JSON.stringify({
    ...seenThrough,
    [identity.scope]: latestCreatedAt,
  }));
  window.dispatchEvent(new Event(announcementsUpdatedEvent));
}

export function notifyAnnouncementsUpdated() {
  window.dispatchEvent(new Event(announcementsUpdatedEvent));
}

export function subscribeToAnnouncementUpdates(listener: () => void) {
  window.addEventListener(announcementsUpdatedEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(announcementsUpdatedEvent, listener);
    window.removeEventListener("storage", listener);
  };
}
