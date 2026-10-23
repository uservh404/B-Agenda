interface StoredAnnouncement {
  id: number;
}

type SeenAnnouncements = Record<string, number[]>;

const announcementsStorageKey = "biblioteca-announcements";
const seenAnnouncementsStorageKey = "biblioteca-announcements-seen";
const announcementsUpdatedEvent = "biblioteca-announcements-updated";

function readAnnouncements(): StoredAnnouncement[] {
  try {
    const storedAnnouncements = window.localStorage.getItem(announcementsStorageKey);
    if (!storedAnnouncements) return [];
    const parsedAnnouncements: unknown = JSON.parse(storedAnnouncements);
    return Array.isArray(parsedAnnouncements) ? parsedAnnouncements as StoredAnnouncement[] : [];
  } catch {
    return [];
  }
}

function readSeenAnnouncements(): SeenAnnouncements {
  try {
    const storedSeenAnnouncements = window.localStorage.getItem(seenAnnouncementsStorageKey);
    if (!storedSeenAnnouncements) return {};
    const parsedSeenAnnouncements: unknown = JSON.parse(storedSeenAnnouncements);
    return parsedSeenAnnouncements && typeof parsedSeenAnnouncements === "object"
      ? parsedSeenAnnouncements as SeenAnnouncements
      : {};
  } catch {
    return {};
  }
}

export function getUnreadAnnouncementCount(userId: number): number {
  const seenIds = new Set(readSeenAnnouncements()[String(userId)] ?? []);
  return readAnnouncements().filter((announcement) => !seenIds.has(announcement.id)).length;
}

export function markAnnouncementsAsSeen(userId: number) {
  const announcements = readAnnouncements();
  const seenAnnouncements = readSeenAnnouncements();
  const key = String(userId);
  const seenIds = new Set(seenAnnouncements[key] ?? []);
  const previousCount = seenIds.size;
  announcements.forEach((announcement) => seenIds.add(announcement.id));

  if (seenIds.size === previousCount) return;

  window.localStorage.setItem(seenAnnouncementsStorageKey, JSON.stringify({
    ...seenAnnouncements,
    [key]: [...seenIds],
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