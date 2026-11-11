export type NotificationKind =
  | "event_assigned"
  | "event_updated"
  | "event_unassigned"
  | "event_cancelled"
  | "permission_granted"
  | "permission_revoked";

export interface NotificationEventDetails {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  description?: string;
  category?: string;
  createdBy?: { id: string | number; name: string };
  assignedWorkers?: { id: string | number; name: string }[];
  reminderEnabled?: boolean;
  reminderValue?: number;
  reminderUnit?: "minutes" | "hours" | "days" | "weeks";
}

export interface AppNotification {
  id: string;
  recipientId: string | number;
  kind: NotificationKind;
  title: string;
  message: string;
  createdAt: string | null;
  readAt: string | null;
  isCurrentAssignment?: boolean;
  event?: NotificationEventDetails;
}

type NewNotification = Omit<AppNotification, "id" | "createdAt" | "readAt">;

const notificationsStorageKey = "biblioteca-notifications";
const notificationsUpdatedEvent = "biblioteca-notifications-updated";
const dismissedAssignmentsStorageKey = "biblioteca-dismissed-assignments";

export function readNotifications(): AppNotification[] {
  try {
    const storedNotifications = window.localStorage.getItem(notificationsStorageKey);
    if (!storedNotifications) return [];
    const parsedNotifications: unknown = JSON.parse(storedNotifications);
    return Array.isArray(parsedNotifications) ? parsedNotifications as AppNotification[] : [];
  } catch {
    return [];
  }
}

function writeNotifications(notifications: AppNotification[]) {
  window.localStorage.setItem(notificationsStorageKey, JSON.stringify(notifications));
  window.dispatchEvent(new Event(notificationsUpdatedEvent));
}

function readDismissedAssignments(): Record<string, string[]> {
  try {
    const storedDismissedAssignments = window.localStorage.getItem(dismissedAssignmentsStorageKey);
    if (!storedDismissedAssignments) return {};
    const parsedDismissedAssignments: unknown = JSON.parse(storedDismissedAssignments);
    return parsedDismissedAssignments && typeof parsedDismissedAssignments === "object"
      ? parsedDismissedAssignments as Record<string, string[]>
      : {};
  } catch {
    return {};
  }
}

export function deleteNotificationsForUser(recipientId: string | number, notificationIds: string[]) {
  const idsToDelete = new Set(notificationIds);
  const currentNotifications = readNotifications();
  const notificationsToDelete = currentNotifications.filter((notification) =>
    notification.recipientId === recipientId && idsToDelete.has(notification.id),
  );
  const updatedNotifications = currentNotifications.filter((notification) =>
    notification.recipientId !== recipientId || !idsToDelete.has(notification.id),
  );
  writeNotifications(updatedNotifications);

  const dismissedEventIds = notificationIds
    .filter((id) => id.startsWith("current-assignment-"))
    .map((id) => id.slice("current-assignment-".length));
  notificationsToDelete.forEach((notification) => {
    if (notification.event) dismissedEventIds.push(notification.event.id);
  });
  if (dismissedEventIds.length > 0) {
    const dismissedAssignments = readDismissedAssignments();
    const userKey = String(recipientId);
    const userDismissedIds = new Set(dismissedAssignments[userKey] ?? []);
    dismissedEventIds.forEach((eventId) => userDismissedIds.add(eventId));
    window.localStorage.setItem(dismissedAssignmentsStorageKey, JSON.stringify({
      ...dismissedAssignments,
      [userKey]: [...userDismissedIds],
    }));
    window.dispatchEvent(new Event(notificationsUpdatedEvent));
  }
}

export function addNotification(notification: NewNotification) {
  const entry: AppNotification = {
    ...notification,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  writeNotifications([entry, ...readNotifications()]);
}

export function markNotificationRead(notificationId: string) {
  const updatedNotifications = readNotifications().map((notification) =>
    notification.id === notificationId && !notification.readAt
      ? { ...notification, readAt: new Date().toISOString() }
      : notification,
  );
  writeNotifications(updatedNotifications);
}

export function markAllNotificationsRead(recipientId: string | number) {
  const readAt = new Date().toISOString();
  const updatedNotifications = readNotifications().map((notification) =>
    notification.recipientId === recipientId && !notification.readAt
      ? { ...notification, readAt }
      : notification,
  );
  writeNotifications(updatedNotifications);
}

export function subscribeToNotificationUpdates(listener: () => void) {
  window.addEventListener(notificationsUpdatedEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(notificationsUpdatedEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

export function readNotificationsForUser(recipientId: string | number): AppNotification[] {
  return readNotifications().filter((notification) => notification.recipientId === recipientId);
}

export function getUnreadNotificationCount(recipientId: string | number): number {
  return readNotificationsForUser(recipientId).filter((notification) =>
    !notification.readAt && !notification.isCurrentAssignment,
  ).length;
}