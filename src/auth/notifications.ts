import { supabase } from "../lib/supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type NotificationKind =
  | "event_assigned"
  | "event_updated"
  | "event_unassigned"
  | "event_cancelled"
  | "event_reminder"
  | "event_admin_created"
  | "event_admin_updated"
  | "event_admin_cancelled"
  | "event_admin_deleted"
  | "permission_granted"
  | "permission_revoked"
  | "role_changed"
  | "admin_role_changed"
  | "admin_permission_changed"
  | "resource_created"
  | "resource_updated"
  | "resource_deleted"
  | "announcement_created"
  | "announcement_updated"
  | "announcement_deleted";

export interface NotificationEventDetails {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  description?: string;
  category?: string;
  status?: "confirmed" | "cancelled" | "unassigned";
  createdBy?: { id?: string; name?: string | null };
  assignedWorkers?: { id: string; name: string }[];
  reminderEnabled?: boolean;
  reminderValue?: number;
  reminderUnit?: "minutes" | "hours" | "days" | "weeks";
}

export interface NotificationResourceDetails {
  name: string;
  category: string;
  quantity: number;
  storedIn: string;
  notes: string[];
  authorName: string;
  actionBy?: string;
}

export interface NotificationAnnouncementDetails {
  title: string;
  content: string;
  category: string;
  authorName: string;
  publishedAt: string;
  actionBy?: string;
}

export interface NotificationPermissionDetails {
  permission: "can_assign_events" | "can_publish_announcements" | "can_manage_resources";
  granted: boolean;
  changedAt: string;
  affectedUserName?: string;
  actionBy?: string;
}

export interface AppNotification {
  id: string;
  recipientId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  eventId?: string;
  event?: NotificationEventDetails;
  resource?: NotificationResourceDetails;
  announcement?: NotificationAnnouncementDetails;
  permission?: NotificationPermissionDetails;
  eventAvailability?: "cancelled" | "unassigned" | "unavailable" | "deleted";
  resourceAvailability?: "deleted" | "unavailable";
  announcementAvailability?: "deleted" | "unavailable";
}

export type NotificationOperationKind = "read" | "delete";
export type NotificationOperationStatus = "pending" | "rejected";

export interface NotificationOutboxOperation {
  scope: string;
  projectId: string;
  userId: string;
  operationId: string;
  notificationId: string;
  notificationTitle?: string;
  kind: NotificationOperationKind;
  status: NotificationOperationStatus;
  createdAt: string;
  lastError?: string;
}

export interface NotificationCacheIdentity {
  projectId: string;
  userId: string;
  scope: string;
}

export interface NotificationCacheBundle {
  notifications: AppNotification[] | null;
  savedAt: string | null;
  operations: NotificationOutboxOperation[];
}

export interface NotificationSyncResult {
  serverReachable: boolean;
  error?: string;
}

const DATABASE_NAME = "agenda-juventud-notification-cache";
const DATABASE_VERSION = 1;
const SNAPSHOTS_STORE = "snapshots";
const OPERATIONS_STORE = "operations";
const updatesEvent = "agenda-juventud-notifications-updated";
const activeSyncs = new Map<string, Promise<NotificationSyncResult>>();
let subscriptionSequence = 0;

export function getNotificationCacheIdentity(userId: string): NotificationCacheIdentity {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!userId || !configuredUrl) {
    throw new Error("No se pudo determinar la cuenta y el proyecto para guardar Notificaciones.");
  }
  let projectId: string;
  try {
    projectId = new URL(configuredUrl).host.toLowerCase();
  } catch {
    throw new Error("La configuración del proyecto para el almacenamiento local no es válida.");
  }
  return { projectId, userId, scope: `${projectId}:${userId}` };
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("El almacenamiento local de Notificaciones no está disponible."));
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
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir la caché local de Notificaciones."));
    request.onblocked = () => reject(new Error("La caché local de Notificaciones está bloqueada."));
  });
}

function isKind(value: unknown): value is NotificationKind {
  return value === "event_assigned"
    || value === "event_updated"
    || value === "event_unassigned"
    || value === "event_cancelled"
    || value === "event_reminder"
    || value === "event_admin_created"
    || value === "event_admin_updated"
    || value === "event_admin_cancelled"
    || value === "event_admin_deleted"
    || value === "permission_granted"
    || value === "permission_revoked"
    || value === "role_changed"
    || value === "admin_role_changed"
    || value === "admin_permission_changed"
    || value === "resource_created"
    || value === "resource_updated"
    || value === "resource_deleted"
    || value === "announcement_created"
    || value === "announcement_updated"
    || value === "announcement_deleted";
}

function parseEventDetails(value: unknown): NotificationEventDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Partial<NotificationEventDetails>;
  if (
    typeof event.id !== "string"
    || typeof event.title !== "string"
    || typeof event.date !== "string"
    || typeof event.startTime !== "string"
    || typeof event.endTime !== "string"
  ) return undefined;
  return event as NotificationEventDetails;
}

export function hasCompleteNotificationEventDetails(
  event: NotificationEventDetails | undefined,
): event is NotificationEventDetails {
  return Boolean(
    event
    && Array.isArray(event.assignedWorkers)
    && event.createdBy
    && typeof event.createdBy === "object"
    && Object.prototype.hasOwnProperty.call(event, "description")
    && Object.prototype.hasOwnProperty.call(event, "category")
    && Object.prototype.hasOwnProperty.call(event, "status")
    && Object.prototype.hasOwnProperty.call(event, "reminderEnabled")
    && Object.prototype.hasOwnProperty.call(event, "reminderValue")
    && Object.prototype.hasOwnProperty.call(event, "reminderUnit"),
  );
}

export type NotificationEventDetailsResult =
  | { available: true; event: NotificationEventDetails }
  | { available: false; reason: "cancelled" | "unassigned" | "deleted" | "not_authorized" | "unknown" };

function redactInaccessibleEventDetails(
  notifications: AppNotification[],
  userId: string,
): AppNotification[] {
  const cancelledEventIds = new Set(notifications
    .filter((notification) =>
      notification.eventAvailability === "cancelled"
      || notification.eventAvailability === undefined && (
        notification.kind === "event_cancelled"
        || notification.kind === "event_admin_cancelled"
        || notification.event?.status === "cancelled"
      ),
    )
    .map((notification) => notification.eventId ?? notification.event?.id)
    .filter((eventId): eventId is string => !!eventId));
  const unassignedEventIds = new Set(notifications
    .filter((notification) =>
      notification.eventAvailability === "unassigned"
      || (notification.kind === "event_unassigned" && notification.event?.status !== "confirmed"),
    )
    .map((notification) => notification.eventId ?? notification.event?.id)
    .filter((eventId): eventId is string => !!eventId));

  return notifications.map((notification) => {
    const event = notification.event;
    const eventId = notification.eventId ?? event?.id;
    const isCancelledEvent = notification.eventAvailability === "cancelled"
      || notification.eventAvailability === undefined && (
        notification.kind === "event_cancelled"
        || notification.kind === "event_admin_cancelled"
        || event?.status === "cancelled"
      )
      || !!eventId && cancelledEventIds.has(eventId);
    const isUnassignedEvent = notification.eventAvailability === "unassigned"
      || (notification.kind === "event_unassigned" && event?.status !== "confirmed")
      || !!eventId && unassignedEventIds.has(eventId);
    const isDeletedEvent = notification.eventAvailability === "deleted"
      || notification.eventAvailability === undefined && notification.kind === "event_admin_deleted";
    const isUnavailableEvent = notification.eventAvailability === "unavailable" || isDeletedEvent;
    if (
      (!isCancelledEvent && !isUnassignedEvent && !isUnavailableEvent)
      || (!isCancelledEvent && !isUnavailableEvent && event?.createdBy?.id === userId)
    ) return notification;
    return {
      ...notification,
      message: isDeletedEvent
        ? "Este evento ya no está disponible."
        : "La información de este evento ya no está disponible para su consulta.",
      eventId,
      event: undefined,
      eventAvailability: isDeletedEvent
        ? "deleted"
        : notification.eventAvailability === "unavailable" ? "unavailable"
        : isCancelledEvent ? "cancelled" : "unassigned",
    };
  });
}

function parseNotification(value: unknown, userId: string): AppNotification {
  if (!value || typeof value !== "object") throw new Error("El servidor devolvió una notificación no válida.");
  const row = value as Partial<{
    id: string;
    recipient_id: string;
    kind: NotificationKind;
    title: string;
    message: string;
    summary: unknown;
    created_at: string;
    read_at: string | null;
  }>;
  if (
    typeof row.id !== "string"
    || row.recipient_id !== userId
    || !isKind(row.kind)
    || typeof row.title !== "string"
    || typeof row.message !== "string"
    || typeof row.created_at !== "string"
    || Number.isNaN(Date.parse(row.created_at))
    || (row.read_at !== null && typeof row.read_at !== "string")
    || !row.summary || typeof row.summary !== "object"
  ) throw new Error("El servidor devolvió datos de notificación incompletos.");

  const summary = row.summary as Record<string, unknown>;
  const notification: AppNotification = {
    id: row.id,
    recipientId: userId,
    kind: row.kind,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
  };
  notification.event = parseEventDetails(summary.event);
  if (typeof summary.eventId === "string") notification.eventId = summary.eventId;
  else if (notification.event) notification.eventId = notification.event.id;
  if (
    summary.eventAvailability === "cancelled"
    || summary.eventAvailability === "unassigned"
    || summary.eventAvailability === "unavailable"
    || summary.eventAvailability === "deleted"
  ) {
    notification.eventAvailability = summary.eventAvailability;
  } else if (
    notification.kind === "event_cancelled"
    || notification.kind === "event_admin_cancelled"
  ) {
    notification.eventAvailability = "cancelled";
  } else if (notification.kind === "event_admin_deleted") {
    notification.eventAvailability = "deleted";
  } else if (notification.kind === "event_unassigned" && notification.event?.status !== "confirmed") {
    notification.eventAvailability = "unassigned";
  } else if (
    notification.kind.startsWith("event_")
    && !notification.event
    && /la información de este evento ya no está disponible/i.test(notification.message)
  ) {
    notification.eventAvailability = "unavailable";
  }
  if (
    summary.resourceAvailability === "deleted"
    || summary.resourceAvailability === "unavailable"
  ) notification.resourceAvailability = summary.resourceAvailability;
  if (
    summary.announcementAvailability === "deleted"
    || summary.announcementAvailability === "unavailable"
  ) notification.announcementAvailability = summary.announcementAvailability;
  if (!notification.resourceAvailability && summary.resource && typeof summary.resource === "object") {
    const resource = summary.resource as Partial<NotificationResourceDetails>;
    if (
      typeof resource.name === "string"
      && typeof resource.category === "string"
      && typeof resource.quantity === "number"
      && typeof resource.storedIn === "string"
      && Array.isArray(resource.notes)
      && typeof resource.authorName === "string"
      && (resource.actionBy === undefined || typeof resource.actionBy === "string")
    ) notification.resource = resource as NotificationResourceDetails;
  }
  if (!notification.announcementAvailability && summary.announcement && typeof summary.announcement === "object") {
    const announcement = summary.announcement as Partial<NotificationAnnouncementDetails>;
    if (
      typeof announcement.title === "string"
      && typeof announcement.content === "string"
      && typeof announcement.category === "string"
      && typeof announcement.authorName === "string"
      && typeof announcement.publishedAt === "string"
      && (announcement.actionBy === undefined || typeof announcement.actionBy === "string")
    ) notification.announcement = announcement as NotificationAnnouncementDetails;
  }
  if (summary.permission && typeof summary.permission === "object") {
    const permission = summary.permission as Partial<NotificationPermissionDetails>;
    if (
      (permission.permission === "can_assign_events"
        || permission.permission === "can_publish_announcements"
        || permission.permission === "can_manage_resources")
      && typeof permission.granted === "boolean"
      && typeof permission.changedAt === "string"
      && (permission.affectedUserName === undefined || typeof permission.affectedUserName === "string")
      && (permission.actionBy === undefined || typeof permission.actionBy === "string")
    ) notification.permission = permission as NotificationPermissionDetails;
  }
  return notification;
}

function notifyChanged() {
  window.dispatchEvent(new Event(updatesEvent));
}

export function subscribeToNotificationUpdates(listener: () => void) {
  window.addEventListener(updatesEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(updatesEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

export function subscribeToNotificationChanges(
  userId: string,
  onChange: () => void,
  onStatus: (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): RealtimeChannel {
  const handleChange = () => {
    onChange();
    notifyChanged();
  };

  return supabase
    .channel(`notifications:${userId}:${++subscriptionSequence}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "notification_change_signals",
      filter: `recipient_id=eq.${userId}`,
    }, handleChange)
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "notification_change_signals",
      filter: `recipient_id=eq.${userId}`,
    }, handleChange)
    .subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "TIMED_OUT" || status === "CLOSED" || status === "CHANNEL_ERROR") {
        onStatus(status);
      }
    });
}

export async function getNotificationEventDetails(notificationId: string): Promise<NotificationEventDetailsResult> {
  const { data, error } = await supabase.rpc("get_notification_admin_scope_event_details_v1", {
    p_notification_id: notificationId,
  });
  if (error) throw new Error(error.message || "No se pudo verificar el acceso a la información del evento.");

  if (data && typeof data === "object" && "available" in data && data.available === false) {
    const reason = "reason" in data ? data.reason : undefined;
    return {
      available: false,
      reason: reason === "cancelled" || reason === "unassigned" || reason === "deleted" || reason === "not_authorized"
        ? reason
        : "unknown",
    };
  }

  const details = parseEventDetails(data);
  if (!details) throw new Error("El servidor devolvió información no válida del evento.");
  if (!hasCompleteNotificationEventDetails(details)) return { available: false, reason: "unknown" };
  return { available: true, event: details };
}

export function removeNotificationChangesSubscription(channel: RealtimeChannel) {
  return supabase.removeChannel(channel);
}

export async function readNotificationCache(identity: NotificationCacheIdentity): Promise<NotificationCacheBundle> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([SNAPSHOTS_STORE, OPERATIONS_STORE], "readwrite");
      const snapshotRequest = transaction.objectStore(SNAPSHOTS_STORE).get(identity.scope);
      const operationsRequest = transaction.objectStore(OPERATIONS_STORE).index("scope").getAll(identity.scope);
      let snapshot: {
        scope: string; projectId: string; userId: string;
        notifications: AppNotification[]; savedAt: string | null;
      } | undefined;
      let cachedNotifications: AppNotification[] | null = null;
      let validationError: Error | null = null;
      snapshotRequest.onsuccess = () => {
        snapshot = snapshotRequest.result as typeof snapshot;
        if (snapshot && (
          snapshot.projectId !== identity.projectId
          || snapshot.userId !== identity.userId
          || !Array.isArray(snapshot.notifications)
          || snapshot.notifications.some((item) => item.recipientId !== identity.userId)
          || (snapshot.savedAt !== null && typeof snapshot.savedAt !== "string")
        )) {
          validationError = new Error("Las notificaciones locales no corresponden a esta cuenta y proyecto.");
          return;
        }
        if (!snapshot) return;
        cachedNotifications = redactInaccessibleEventDetails(snapshot.notifications, identity.userId);
        if (cachedNotifications.some((notification, index) => notification !== snapshot?.notifications[index])) {
          transaction.objectStore(SNAPSHOTS_STORE).put({
            ...snapshot,
            notifications: cachedNotifications,
          });
        }
      };
      transaction.oncomplete = () => {
        if (validationError) {
          reject(validationError);
          return;
        }
        const operations = (operationsRequest.result as NotificationOutboxOperation[]).filter((operation) =>
          operation.scope === identity.scope
          && operation.userId === identity.userId
          && operation.projectId === identity.projectId
          && typeof operation.operationId === "string"
          && typeof operation.notificationId === "string"
          && (operation.kind === "read" || operation.kind === "delete")
          && (operation.status === "pending" || operation.status === "rejected"),
        );
        resolve({
          notifications: cachedNotifications,
          savedAt: snapshot?.savedAt ?? null,
          operations,
        });
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudieron leer las notificaciones locales."));
      transaction.onabort = () => reject(transaction.error ?? new Error("La lectura de Notificaciones fue cancelada."));
    });
  } finally {
    database.close();
  }
}

async function saveNotificationSnapshot(
  identity: NotificationCacheIdentity,
  notifications: AppNotification[],
  savedAt: string | null,
) {
  const safeNotifications = redactInaccessibleEventDetails(notifications, identity.userId);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOTS_STORE, "readwrite");
      transaction.objectStore(SNAPSHOTS_STORE).put({
        scope: identity.scope,
        projectId: identity.projectId,
        userId: identity.userId,
        notifications: safeNotifications,
        savedAt,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar la copia local de Notificaciones."));
      transaction.onabort = () => reject(transaction.error ?? new Error("El guardado de Notificaciones fue cancelado."));
    });
  } finally {
    database.close();
  }
}

export async function cacheAuthorizedNotificationEventDetails(
  notificationId: string,
  userId: string,
  event: NotificationEventDetails,
) {
  const identity = getNotificationCacheIdentity(userId);
  const bundle = await readNotificationCache(identity);
  if (!bundle.notifications) return;
  const notification = bundle.notifications.find((item) => item.id === notificationId);
  if (!notification) return;

  const updatedNotifications = bundle.notifications.map((item) =>
    item.id === notificationId || item.eventId === event.id || item.event?.id === event.id
      ? { ...item, eventId: event.id, event, eventAvailability: undefined }
      : item,
  );
  await saveNotificationSnapshot(identity, updatedNotifications, bundle.savedAt);
  notifyChanged();
}

export async function redactCachedNotificationEventDetails(
  notificationId: string,
  userId: string,
  reason: "cancelled" | "unassigned" | "unavailable" | "deleted",
) {
  const identity = getNotificationCacheIdentity(userId);
  const bundle = await readNotificationCache(identity);
  if (!bundle.notifications) return;
  const notification = bundle.notifications.find((item) => item.id === notificationId);
  if (!notification) return;

  const eventId = notification.eventId ?? notification.event?.id;
  const message = reason === "unassigned"
    ? "Ya no estás asignado a este evento."
    : reason === "deleted"
      ? "Este evento ya no está disponible."
      : "La información de este evento ya no está disponible para su consulta.";
  const updatedNotifications = bundle.notifications.map((item) =>
    item.id === notificationId
      || (!!eventId && (item.eventId === eventId || item.event?.id === eventId))
      ? { ...item, eventId, event: undefined, eventAvailability: reason, message }
      : item,
  );
  await saveNotificationSnapshot(identity, updatedNotifications, bundle.savedAt);
  notifyChanged();
}

async function enqueueOperation(
  identity: NotificationCacheIdentity,
  notificationId: string,
  kind: NotificationOperationKind,
  notificationTitle: string,
) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.index("scope").getAll(identity.scope);
      request.onsuccess = () => {
        const alreadyQueued = (request.result as NotificationOutboxOperation[]).some((operation) =>
          operation.notificationId === notificationId
          && operation.kind === kind
          && operation.status === "pending",
        );
        if (!alreadyQueued) {
          store.add({
            scope: identity.scope,
            projectId: identity.projectId,
            userId: identity.userId,
            operationId: crypto.randomUUID(),
            notificationId,
            notificationTitle,
            kind,
            status: "pending",
            createdAt: new Date().toISOString(),
          } satisfies NotificationOutboxOperation);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el cambio pendiente de Notificaciones."));
      transaction.onabort = () => reject(transaction.error ?? new Error("El cambio pendiente de Notificaciones fue cancelado."));
    });
  } finally {
    database.close();
  }
}

async function removeOperation(identity: NotificationCacheIdentity, operationId: string) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
      const store = transaction.objectStore(OPERATIONS_STORE);
      const request = store.get([identity.scope, operationId]);
      request.onsuccess = () => {
        const operation = request.result as NotificationOutboxOperation | undefined;
        if (operation?.userId === identity.userId && operation.projectId === identity.projectId) {
          store.delete([identity.scope, operationId]);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo completar el cambio de Notificaciones."));
      transaction.onabort = () => reject(transaction.error ?? new Error("El cambio de Notificaciones fue cancelado."));
    });
  } finally {
    database.close();
  }
}

function mergeNotifications(
  snapshot: AppNotification[],
  operations: NotificationOutboxOperation[],
): AppNotification[] {
  const notifications = new Map(snapshot.map((notification) => [notification.id, notification]));
  for (const operation of operations) {
    const current = notifications.get(operation.notificationId);
    if (!current) continue;
    if (operation.kind === "delete") {
      notifications.delete(operation.notificationId);
    } else {
      notifications.set(operation.notificationId, { ...current, readAt: current.readAt ?? operation.createdAt });
    }
  }
  return [...notifications.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

export async function readNotificationsForUser(userId: string): Promise<AppNotification[]> {
  const identity = getNotificationCacheIdentity(userId);
  const bundle = await readNotificationCache(identity);
  return mergeNotifications(bundle.notifications ?? [], bundle.operations);
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  return (await readNotificationsForUser(userId)).filter((notification) => !notification.readAt).length;
}

export async function markNotificationRead(notificationId: string, userId: string) {
  const identity = getNotificationCacheIdentity(userId);
  const bundle = await readNotificationCache(identity);
  const notification = bundle.notifications?.find((item) => item.id === notificationId && item.recipientId === userId);
  if (!notification || notification.readAt) return;
  await enqueueOperation(identity, notificationId, "read", notification.title);
  notifyChanged();
}

export async function markAllNotificationsRead(userId: string) {
  const notifications = await readNotificationsForUser(userId);
  const identity = getNotificationCacheIdentity(userId);
  for (const notification of notifications) {
    if (!notification.readAt) await enqueueOperation(identity, notification.id, "read", notification.title);
  }
  notifyChanged();
}

export async function deleteNotificationsForUser(userId: string, notificationIds: string[]) {
  const identity = getNotificationCacheIdentity(userId);
  const bundle = await readNotificationCache(identity);
  const knownNotifications = new Map((bundle.notifications ?? [])
    .filter((notification) => notification.recipientId === userId)
    .map((notification) => [notification.id, notification]));
  for (const notificationId of new Set(notificationIds)) {
    const notification = knownNotifications.get(notificationId);
    if (notification) await enqueueOperation(identity, notificationId, "delete", notification.title);
  }
  notifyChanged();
}

async function runNotificationSync(identity: NotificationCacheIdentity): Promise<NotificationSyncResult> {
  if (!window.navigator.onLine) return { serverReachable: false, error: "Sin conexión." };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || sessionData.session?.user.id !== identity.userId) {
    return { serverReachable: false, error: "La sesión no corresponde a las notificaciones guardadas." };
  }
  const { data, error } = await supabase.rpc("list_notifications_resource_announcement_scope_v1");
  if (error || !Array.isArray(data)) {
    return { serverReachable: false, error: error?.message ?? "No se pudo consultar la lista de Notificaciones." };
  }
  const notifications = data.map((row: unknown) => parseNotification(row, identity.userId));
  await saveNotificationSnapshot(identity, notifications, new Date().toISOString());
  notifyChanged();
  const { operations } = await readNotificationCache(identity);
  for (const operation of operations) {
    if (operation.status !== "pending") continue;
    try {
      const { data: result, error: applyError } = await supabase.rpc("apply_notification_operation_v1", {
        p_operation_id: operation.operationId,
        p_kind: operation.kind,
        p_notification_id: operation.notificationId,
      });
      if (applyError) {
        if (!window.navigator.onLine) return { serverReachable: false, error: "La conexión se perdió. Los cambios se conservaron localmente." };
        return { serverReachable: true, error: "No se pudo confirmar un cambio de Notificaciones." };
      }
      if (!result || typeof result !== "object") return { serverReachable: true, error: "La respuesta del servidor no fue válida." };
      const response = result as { status?: string; code?: string };
      if (response.status === "confirmed") {
        await removeOperation(identity, operation.operationId);
      } else {
        const database = await openDatabase();
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
            const store = transaction.objectStore(OPERATIONS_STORE);
            const request = store.get([identity.scope, operation.operationId]);
            request.onsuccess = () => {
              const current = request.result as NotificationOutboxOperation | undefined;
              if (current?.userId === identity.userId) {
                store.put({ ...current, status: "rejected", lastError: response.code ?? "not_authorized" });
              }
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error ?? new Error("No se pudo guardar el estado del cambio."));
          });
        } finally {
          database.close();
        }
      }
    } catch (syncError) {
      return {
        serverReachable: false,
        error: syncError instanceof Error ? syncError.message : "No se pudo sincronizar Notificaciones.",
      };
    }
  }
  const { data: refreshed, error: refreshError } = await supabase.rpc("list_notifications_resource_announcement_scope_v1");
  if (refreshError || !Array.isArray(refreshed)) {
    return { serverReachable: false, error: "No se pudo actualizar la copia de Notificaciones." };
  }
  const refreshedNotifications = refreshed.map((row: unknown) => parseNotification(row, identity.userId));
  const remaining = (await readNotificationCache(identity)).operations;
  await saveNotificationSnapshot(
    identity,
    refreshedNotifications,
    new Date().toISOString(),
  );
  notifyChanged();
  return remaining.length
    ? { serverReachable: true, error: "Algunos cambios de Notificaciones requieren revisión." }
    : { serverReachable: true };
}

export function synchronizeNotifications(identity: NotificationCacheIdentity): Promise<NotificationSyncResult> {
  const current = activeSyncs.get(identity.scope);
  if (current) return current;
  const promise = runNotificationSync(identity).finally(() => {
    if (activeSyncs.get(identity.scope) === promise) activeSyncs.delete(identity.scope);
  });
  activeSyncs.set(identity.scope, promise);
  return promise;
}

export async function refreshNotifications(identity: NotificationCacheIdentity) {
  const result = await synchronizeNotifications(identity);
  if (result.serverReachable) notifyChanged();
  return result;
}

export function subscribeToNotificationUpdatesForUser(userId: string, listener: () => void) {
  const channel = subscribeToNotificationChanges(userId, listener, () => undefined);
  return () => { void supabase.removeChannel(channel); };
}
