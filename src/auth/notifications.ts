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
  createdBy?: { id: number; name: string };
  assignedWorkers?: { id: number; name: string }[];
  reminderEnabled?: boolean;
  reminderValue?: number;
  reminderUnit?: "minutes" | "hours" | "days" | "weeks";
}

export interface AppNotification {
  id: string;
  recipientId: number;
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
const eventsUpdatedEvent = "biblioteca-events-updated";

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

export function deleteNotificationsForUser(recipientId: number, notificationIds: string[]) {
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

export function markAllNotificationsRead(recipientId: number) {
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
  window.addEventListener(eventsUpdatedEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(notificationsUpdatedEvent, listener);
    window.removeEventListener(eventsUpdatedEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

export function readNotificationsForUser(recipientId: number): AppNotification[] {
  let activeEventIds: Set<string> | null = null;
  try {
    const storedEvents = window.localStorage.getItem("biblioteca-events");
    const parsedEvents: unknown = storedEvents ? JSON.parse(storedEvents) : [];
    if (Array.isArray(parsedEvents)) {
      activeEventIds = new Set(parsedEvents
        .filter((event): event is { id: string | number } => Boolean(event && typeof event === "object" && "id" in event))
        .map((event) => String(event.id)));
    }
  } catch {
    activeEventIds = null;
  }

  const notifications = readNotifications().filter((notification) =>
    notification.recipientId === recipientId &&
    (!notification.event || activeEventIds === null || activeEventIds.has(notification.event.id)),
  );
  const dismissedEventIds = new Set(readDismissedAssignments()[String(recipientId)] ?? []);
  const notifiedEventIds = new Set(
    notifications
      .filter((notification) => notification.event)
      .map((notification) => notification.event!.id),
  );

  try {
    const storedEvents = window.localStorage.getItem("biblioteca-events");
    if (!storedEvents) return notifications;
    const parsedEvents: unknown = JSON.parse(storedEvents);
    if (!Array.isArray(parsedEvents)) return notifications;

    const currentAssignments = parsedEvents.flatMap((event) => {
      if (
        !event ||
        typeof event !== "object" ||
        !Array.isArray(event.assignedWorkers) ||
        !event.assignedWorkers.some((worker: { id?: number }) => worker.id === recipientId) ||
        dismissedEventIds.has(String(event.id)) ||
        notifiedEventIds.has(String(event.id))
      ) {
        return [];
      }

      return [{
        id: `current-assignment-${String(event.id)}`,
        recipientId,
        kind: "event_assigned" as const,
        title: "Evento en tu agenda",
        message: "Este evento está asignado actualmente a tu cuenta.",
        createdAt: null,
        readAt: null,
        isCurrentAssignment: true,
        event: {
          id: String(event.id),
          title: String(event.title ?? "Evento"),
          date: String(event.date ?? ""),
          startTime: String(event.startTime ?? ""),
          endTime: String(event.endTime ?? ""),
          description: String(event.description ?? ""),
          category: String(event.category ?? ""),
          createdBy: event.createdBy && typeof event.createdBy === "object"
            ? { id: Number(event.createdBy.id), name: String(event.createdBy.name ?? "") }
            : undefined,
          assignedWorkers: Array.isArray(event.assignedWorkers)
            ? event.assignedWorkers.map((worker: { id?: number; name?: string }) => ({ id: Number(worker.id), name: String(worker.name ?? "") }))
            : [],
          reminderEnabled: Boolean(event.reminderEnabled),
          reminderValue: Number(event.reminderValue ?? 0),
          reminderUnit: event.reminderUnit as NotificationEventDetails["reminderUnit"],
        },
      }];
    });

    return [...currentAssignments, ...notifications];
  } catch {
    return notifications;
  }
}

export function getUnreadNotificationCount(recipientId: number): number {
  return readNotificationsForUser(recipientId).filter((notification) =>
    !notification.readAt && !notification.isCurrentAssignment,
  ).length;
}