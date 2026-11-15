import {
  getAnnouncementCacheIdentity,
  readAnnouncementCache,
} from "../services/announcement-offline-cache";

const seenThroughStorageKey = "agenda-juventud-announcements-seen-through";
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

export async function getUnreadAnnouncementCount(userId: string): Promise<number> {
  if (!userId) return 0;
  const identity = getAnnouncementCacheIdentity(userId);
  const bundle = await readAnnouncementCache(identity);
  const seenThrough = readSeenThrough()[identity.scope] ?? "";
  return (bundle.announcements ?? []).filter((announcement) =>
    announcement.createdAt > seenThrough,
  ).length;
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
