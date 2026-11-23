import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  Eye,
  ListChecks,
  Megaphone,
  Package,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Sidebar from "../components/Sidebar";
import EventSummaryDialog from "../components/EventSummaryDialog";
import SyncStatusPanel, { type SyncPanelOperation } from "../components/SyncStatusPanel";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAuth } from "../auth/useAuth";
import {
  deleteNotificationsForUser,
  cacheAuthorizedNotificationEventDetails,
  getNotificationEventDetails,
  getNotificationCacheIdentity,
  hasCompleteNotificationEventDetails,
  markAllNotificationsRead,
  markNotificationRead,
  readNotificationCache,
  readNotificationsForUser,
  redactCachedNotificationEventDetails,
  removeNotificationChangesSubscription,
  subscribeToNotificationChanges,
  subscribeToNotificationUpdates,
  synchronizeNotifications,
  type AppNotification,
  type NotificationCacheBundle,
  type NotificationEventDetails,
  type NotificationKind,
  type NotificationOutboxOperation,
  type NotificationResourceDetails,
  type NotificationAnnouncementDetails,
  type NotificationPermissionDetails,
} from "../auth/notifications";
import "./S-notificaciones.css";

const notificationLabels: Record<NotificationKind, { label: string; tone: string }> = {
  event_assigned: { label: "Evento asignado", tone: "blue" },
  event_updated: { label: "Evento actualizado", tone: "amber" },
  event_unassigned: { label: "Cambio de asignación", tone: "amber" },
  event_cancelled: { label: "Evento cancelado", tone: "red" },
  event_reminder: { label: "Recordatorio de evento", tone: "blue" },
  event_admin_created: { label: "Aviso de evento", tone: "blue" },
  event_admin_updated: { label: "Aviso de evento", tone: "amber" },
  event_admin_cancelled: { label: "Aviso de evento", tone: "red" },
  event_admin_deleted: { label: "Aviso de evento", tone: "red" },
  permission_granted: { label: "Permiso habilitado", tone: "green" },
  permission_revoked: { label: "Permiso retirado", tone: "red" },
  role_changed: { label: "Cambio de rol", tone: "amber" },
  admin_role_changed: { label: "Cambio de rol de usuario", tone: "amber" },
  admin_permission_changed: { label: "Cambio de permiso de usuario", tone: "blue" },
  resource_created: { label: "Recurso creado", tone: "green" },
  resource_updated: { label: "Recurso actualizado", tone: "amber" },
  resource_deleted: { label: "Recurso eliminado", tone: "red" },
  announcement_created: { label: "Anuncio creado", tone: "blue" },
  announcement_updated: { label: "Anuncio actualizado", tone: "amber" },
  announcement_deleted: { label: "Anuncio eliminado", tone: "red" },
};

const permissionLabels: Record<NotificationPermissionDetails["permission"], string> = {
  can_assign_events: "Asignar eventos",
  can_publish_announcements: "Publicar Anuncios",
  can_manage_resources: "Gestionar Recursos",
};
const emptyBundle: NotificationCacheBundle = {
  notifications: null,
  savedAt: null,
  operations: [],
};

function getIdentity(userId: string | undefined) {
  if (!userId) return null;
  try {
    return getNotificationCacheIdentity(userId);
  } catch {
    return null;
  }
}

function NotificationInfoDialog({
  details,
  onClose,
  isOfflineSnapshot,
}: {
  details: NotificationResourceDetails | NotificationAnnouncementDetails | NotificationPermissionDetails;
  onClose: () => void;
  isOfflineSnapshot: boolean;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const isResource = "storedIn" in details;
  const isAnnouncement = "publishedAt" in details;
  const title = isResource ? details.name : isAnnouncement ? details.title : "Cambio de permiso";
  const icon = isResource ? <Package size={22} /> : isAnnouncement ? <Megaphone size={22} /> : <ShieldCheck size={22} />;

  return (
    <div className="notification-info-backdrop" onClick={onClose}>
      <section className="notification-info-dialog" role="dialog" aria-modal="true" aria-labelledby="notification-info-title" onClick={(event) => event.stopPropagation()}>
        <header className="notification-info-header">
          <span className="notification-info-icon" aria-hidden="true">{icon}</span>
          <div><span>Ver información</span><h2 id="notification-info-title">{title}</h2></div>
          <button type="button" className="notification-info-close" aria-label="Cerrar información" onClick={onClose}>×</button>
        </header>
        <div className="notification-info-content">
          {isOfflineSnapshot && (
            <p className="notification-info-offline-note" role="status">
              Datos guardados sin conexión. No se pueden verificar cambios recientes.
            </p>
          )}
          {isResource && (
            <>
              <p><span>Categoría</span><strong>{details.category}</strong></p>
              <p><span>Cantidad</span><strong>{details.quantity}</strong></p>
              <p><span>Almacenamiento</span><strong>{details.storedIn}</strong></p>
              <p><span>Observaciones</span><strong>{details.notes.length ? details.notes.join("\n") : "Sin observaciones."}</strong></p>
              <p><span>{details.actionBy ? "Acción realizada por" : "Registró"}</span><strong>{details.actionBy ?? details.authorName}</strong></p>
            </>
          )}
          {isAnnouncement && (
            <>
              <p><span>Autor</span><strong>{details.authorName}</strong></p>
              {details.actionBy && details.actionBy !== details.authorName && (
                <p><span>Acción realizada por</span><strong>{details.actionBy}</strong></p>
              )}
              <p><span>Categoría</span><strong>{details.category}</strong></p>
              <p><span>Publicado</span><strong>{new Date(details.publishedAt).toLocaleString("es-MX")}</strong></p>
              <section><span>Contenido</span><p>{details.content}</p></section>
            </>
          )}
          {!isResource && !isAnnouncement && (
            <>
              {details.affectedUserName && <p><span>Usuario afectado</span><strong>{details.affectedUserName}</strong></p>}
              {details.actionBy && <p><span>Realizó el cambio</span><strong>{details.actionBy}</strong></p>}
              <p><span>Permiso</span><strong>{permissionLabels[details.permission]}</strong></p>
              <p><span>Estado</span><strong>{details.granted ? "Otorgado" : "Retirado"}</strong></p>
              <p><span>Fecha del cambio</span><strong>{new Date(details.changedAt).toLocaleString("es-MX")}</strong></p>
            </>
          )}
        </div>
        <footer className="notification-info-footer"><button type="button" onClick={onClose}>Cerrar</button></footer>
      </section>
    </div>
  );
}

function getNotificationIcon(kind: NotificationKind) {
  if (kind.startsWith("event_")) return <CalendarDays size={17} aria-hidden="true" />;
  if (kind.startsWith("resource_")) return <Package size={17} aria-hidden="true" />;
  if (kind.startsWith("announcement_")) return <Megaphone size={17} aria-hidden="true" />;
  if (kind === "role_changed" || kind === "admin_role_changed" || kind === "admin_permission_changed") return <ShieldCheck size={17} aria-hidden="true" />;
  if (kind.startsWith("permission_")) return <ShieldCheck size={17} aria-hidden="true" />;
  return <Bell size={17} aria-hidden="true" />;
}

function getNotificationDetails(notification: AppNotification) {
  return notification.event
    ?? notification.resource
    ?? notification.announcement
    ?? notification.permission
    ?? null;
}

function getNotificationTitle(notification: AppNotification) {
  if (notification.kind === "resource_created") return "Recurso creado";
  if (notification.kind === "announcement_created") return "Anuncio creado";
  return notification.title;
}

function isConnectionError(message: string) {
  return /sin conexión|conexión se perdió|fetch failed|failed to fetch|load failed|timed out|network request failed|networkerror|err_internet|err_network/i.test(message);
}

function isAccessDeniedError(message: string) {
  return /not_authorized|permission denied|access denied|42501/i.test(message);
}

function getNotificationEventDetailsWithTimeout(notificationId: string) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error("notification_access_check_timeout")),
      10000,
    );
  });
  return Promise.race([
    getNotificationEventDetails(notificationId),
    timeout,
  ]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function Notificaciones() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const identity = useMemo(() => getIdentity(userId), [userId]);
  const [cache, setCache] = useState<NotificationCacheBundle>(emptyBundle);
  const [cacheLoadedScope, setCacheLoadedScope] = useState<string | null>(null);
  const [notificationTitles, setNotificationTitles] = useState<{ scope: string; titles: Record<string, string> }>({
    scope: "",
    titles: {},
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{
    ids: string[];
    mode: "single" | "multiple";
    notificationTitle?: string;
  } | null>(null);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteInProgressRef = useRef(false);
  const [detailsToView, setDetailsToView] = useState<
    NotificationResourceDetails | NotificationAnnouncementDetails | NotificationPermissionDetails | null
  >(null);
  const [detailsOfflineSnapshot, setDetailsOfflineSnapshot] = useState(false);
  const detailsModalOpenRef = useRef(false);
  const [eventToView, setEventToView] = useState<NotificationEventDetails | null>(null);
  const [eventDetailsOfflineSnapshot, setEventDetailsOfflineSnapshot] = useState(false);
  const [eventDetailsNotificationId, setEventDetailsNotificationId] = useState<string | null>(null);
  const [eventUnavailableReason, setEventUnavailableReason] = useState<
    "cancelled" | "unassigned" | "deleted" | "offline" | "general" | null
  >(null);
  const [openingEventId, setOpeningEventId] = useState<string | null>(null);
  const [eventDetailsError, setEventDetailsError] = useState("");
  const [syncErrorState, setSyncErrorState] = useState<{ scope: string; message: string } | null>(null);
  const [realtimeWarningState, setRealtimeWarningState] = useState<{ scope: string; message: string } | null>(null);
  const [serverState, setServerState] = useState<{ scope: string; reachable: boolean }>({ scope: "", reachable: false });
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const syncPromisesRef = useRef(new Map<string, Promise<void>>());
  const activeIdentityRef = useRef(identity);

  const activeCache = identity && cacheLoadedScope === identity.scope ? cache : emptyBundle;
  const notifications = activeCache.notifications ?? [];
  const operations = activeCache.operations;
  const displayedSyncError = syncErrorState && syncErrorState.scope === identity?.scope
    ? syncErrorState.message
    : "";
  const displayedRealtimeWarning = realtimeWarningState && realtimeWarningState.scope === identity?.scope
    ? realtimeWarningState.message
    : "";
  const isConnectionAvailable = isOnline && window.navigator.onLine;
  const serverReachable = serverState.scope === identity?.scope && serverState.reachable;
  const isUsingCachedDataOffline = !isConnectionAvailable
    || (serverState.scope === identity?.scope
      && !serverReachable
      && isConnectionError(displayedSyncError));
  const previousConnectivityRef = useRef({ online: false, reachable: false });
  const isSyncing = syncingScope === identity?.scope;
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  const pendingCount = operations.filter((operation) => operation.status === "pending").length;
  const pendingDeletionCount = operations.filter(
    (operation) => operation.kind === "delete" && operation.status === "pending",
  ).length;
  const hasRejectedOperations = operations.some((operation) => operation.status === "rejected");
  const statusLabel = !isConnectionAvailable
    ? "Sin conexión"
    : isSyncing
      ? "Sincronizando"
      : hasRejectedOperations || !!displayedSyncError || !!displayedRealtimeWarning
        ? "Requiere atención"
      : pendingCount > 0
        ? "Sincronización pendiente"
          : serverReachable ? "Todo sincronizado" : "Sincronización pendiente";
  const visibleSelectedIds = selectedIds.filter((id) => notifications.some((notification) => notification.id === id));
  const allNotificationsSelected = notifications.length > 0
    && notifications.every((notification) => visibleSelectedIds.includes(notification.id));

  const refreshLocalCache = useCallback(async (targetUserId: string) => {
    const [bundle, items] = await Promise.all([
      readNotificationCache(getNotificationCacheIdentity(targetUserId)),
      readNotificationsForUser(targetUserId),
    ]);
    const targetIdentity = getNotificationCacheIdentity(targetUserId);
    const titles = Object.fromEntries((bundle.notifications ?? []).map((notification) => [notification.id, notification.title]));
    if (activeIdentityRef.current?.scope === targetIdentity.scope) {
      setCache({ ...bundle, notifications: items });
      setCacheLoadedScope(targetIdentity.scope);
      setNotificationTitles((current) => ({
        scope: targetIdentity.scope,
        titles: { ...(current.scope === targetIdentity.scope ? current.titles : {}), ...titles },
      }));
    }
    return bundle;
  }, []);

  useLayoutEffect(() => {
    activeIdentityRef.current = identity;
  }, [identity]);

  const syncAndRefresh = useCallback((): Promise<void> => {
    if (!identity || !window.navigator.onLine) return Promise.resolve();
    const active = syncPromisesRef.current.get(identity.scope);
    if (active) return active;
    const target = identity;
    setSyncingScope(target.scope);
    const task = (async () => {
      try {
        const result = await synchronizeNotifications(target);
        setServerState({ scope: target.scope, reachable: result.serverReachable });
        setSyncErrorState({ scope: target.scope, message: result.error ?? "" });
        if (
          !result.serverReachable
          && isConnectionError(result.error ?? "")
          && detailsModalOpenRef.current
        ) setDetailsOfflineSnapshot(true);
        await refreshLocalCache(target.userId);
      } catch (error) {
        setSyncErrorState({
          scope: target.scope,
          message: error instanceof Error ? error.message : "No se pudo sincronizar Notificaciones.",
        });
      } finally {
        syncPromisesRef.current.delete(target.scope);
        setSyncingScope((scope) => scope === target.scope ? null : scope);
      }
    })();
    syncPromisesRef.current.set(target.scope, task);
    return task;
  }, [identity, refreshLocalCache]);

  useEffect(() => {
    const updateConnection = () => {
      const online = window.navigator.onLine;
      setIsOnline(online);
      if (!online) {
        if (detailsModalOpenRef.current) setDetailsOfflineSnapshot(true);
        setServerState((current) => ({ ...current, reachable: false }));
        setRealtimeWarningState(null);
      }
    };
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    let active = true;
    queueMicrotask(() => {
      void refreshLocalCache(identity.userId).catch((error: unknown) => {
        if (active) setSyncErrorState({
          scope: identity.scope,
          message: error instanceof Error ? error.message : "No se pudo leer la caché de Notificaciones.",
        });
      });
    });
    const unsubscribe = subscribeToNotificationUpdates(() => {
      void refreshLocalCache(identity.userId).catch((error: unknown) => {
        setSyncErrorState({
          scope: identity.scope,
          message: error instanceof Error ? error.message : "No se pudo actualizar la caché de Notificaciones.",
        });
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [identity, refreshLocalCache]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isConnectionAvailable) return;
    queueMicrotask(() => { void syncAndRefresh(); });
  }, [identity, cacheLoadedScope, isConnectionAvailable, syncAndRefresh]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isConnectionAvailable) return;
    const intervalId = window.setInterval(() => {
      if (window.navigator.onLine) void syncAndRefresh();
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [identity, cacheLoadedScope, isConnectionAvailable, syncAndRefresh]);

  useEffect(() => {
    if (!identity || !userId || !isConnectionAvailable) return;
    let active = true;
    const channel = subscribeToNotificationChanges(
      userId,
      () => {
        if (active) void syncAndRefresh();
      },
      (channelStatus) => {
        if (!active) return;
        if (channelStatus === "SUBSCRIBED") {
          setRealtimeWarningState(null);
        } else if (
          (channelStatus === "CHANNEL_ERROR" || channelStatus === "TIMED_OUT")
          && window.navigator.onLine
        ) {
          setRealtimeWarningState({
            scope: identity.scope,
            message: "Realtime de Notificaciones no está disponible; la actualización periódica y manual siguen disponibles.",
          });
        }
      },
    );
    return () => {
      active = false;
      void removeNotificationChangesSubscription(channel);
    };
  }, [identity, userId, isConnectionAvailable, syncAndRefresh]);

  const handleMarkRead = async (notificationId: string) => {
    try {
      await markNotificationRead(notificationId, userId);
      await refreshLocalCache(userId);
      if (window.navigator.onLine) await syncAndRefresh();
    } catch (error) {
      setSyncErrorState({ scope: identity?.scope ?? "", message: error instanceof Error ? error.message : "No se pudo guardar el cambio local." });
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead(userId);
      await refreshLocalCache(userId);
      if (window.navigator.onLine) await syncAndRefresh();
    } catch (error) {
      setSyncErrorState({ scope: identity?.scope ?? "", message: error instanceof Error ? error.message : "No se pudieron marcar las notificaciones como leídas." });
    }
  };

  const handleDelete = async (notificationIds: string[], multiple = false) => {
    try {
      await deleteNotificationsForUser(userId, notificationIds);
      setSelectedIds((ids) => ids.filter((id) => !notificationIds.includes(id)));
      if (multiple) {
        setSelectionMode(false);
        setSelectedIds([]);
      }
      setDeleteDialog(null);
      setDeleteDialogError("");
      try {
        await refreshLocalCache(userId);
      } catch (error) {
        setSyncErrorState({
          scope: identity?.scope ?? "",
          message: error instanceof Error ? error.message : "No se pudo actualizar la lista local de Notificaciones.",
        });
      }
      if (window.navigator.onLine) await syncAndRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo guardar la eliminación local.";
      setSyncErrorState({ scope: identity?.scope ?? "", message });
      if (deleteDialog) setDeleteDialogError(message);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteDialog || isDeleting || deleteInProgressRef.current) return;
    const ids = deleteDialog.ids.filter((id) => notifications.some((notification) => notification.id === id));
    if (ids.length === 0) {
      setDeleteDialog(null);
      setDeleteDialogError("");
      return;
    }
    deleteInProgressRef.current = true;
    setDeleteDialogError("");
    setIsDeleting(true);
    try {
      await handleDelete(ids, deleteDialog.mode === "multiple");
    } finally {
      deleteInProgressRef.current = false;
      setIsDeleting(false);
    }
  };

  const handleViewEvent = async (notification: AppNotification) => {
    if (!notification.event && !notification.kind.startsWith("event_")) return;
    setEventDetailsError("");
    setEventToView(null);
    setEventUnavailableReason(null);
    setEventDetailsOfflineSnapshot(false);
    setEventDetailsNotificationId(notification.id);
    const showCachedEventOffline = () => {
      if (
        notification.eventAvailability === "cancelled"
        || notification.event?.status === "cancelled"
        || notification.eventAvailability === undefined
          && (notification.kind === "event_cancelled" || notification.kind === "event_admin_cancelled")
      ) {
        setEventUnavailableReason("cancelled");
        return;
      }
      if (
        notification.eventAvailability === "unassigned"
        || notification.kind === "event_unassigned"
      ) {
        setEventUnavailableReason("unassigned");
        return;
      }
      if (notification.eventAvailability === "unavailable") {
        setEventUnavailableReason("general");
        return;
      }
      if (
        notification.eventAvailability === "deleted"
        || notification.eventAvailability === undefined && notification.kind === "event_admin_deleted"
      ) {
        setEventUnavailableReason("deleted");
        return;
      }
      if (!hasCompleteNotificationEventDetails(notification.event)) {
        setEventUnavailableReason("offline");
        return;
      }
      setEventToView(notification.event);
      setEventDetailsOfflineSnapshot(true);
    };
    if (!isConnectionAvailable) {
      showCachedEventOffline();
      return;
    }
    setOpeningEventId(notification.id);
    try {
      const result = await getNotificationEventDetailsWithTimeout(notification.id);
      if (result.available) {
        if (result.event.status === "cancelled") {
          setEventUnavailableReason("cancelled");
          await redactCachedNotificationEventDetails(notification.id, userId, "cancelled");
          await refreshLocalCache(userId);
        } else {
          setEventToView(result.event);
          setEventDetailsOfflineSnapshot(false);
          try {
            await cacheAuthorizedNotificationEventDetails(notification.id, userId, result.event);
            await refreshLocalCache(userId);
          } catch (cacheError) {
            setEventDetailsError(cacheError instanceof Error
              ? cacheError.message
              : "No se pudo actualizar la copia local de la información.");
          }
        }
      } else {
        const reason = result.reason;
        const accessState = reason === "cancelled"
          ? "cancelled"
          : reason === "unassigned" ? "unassigned"
            : reason === "deleted" ? "deleted" : "unavailable";
        setEventUnavailableReason(reason === "cancelled"
          ? "cancelled"
          : reason === "unassigned" ? "unassigned"
            : reason === "deleted" ? "deleted" : "general");
        try {
          await redactCachedNotificationEventDetails(notification.id, userId, accessState);
          await refreshLocalCache(userId);
        } catch (cacheError) {
          setEventDetailsError(cacheError instanceof Error
            ? cacheError.message
            : "No se pudo sanear la copia local de la información.");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "notification_access_check_timeout" || isConnectionError(message)) {
        showCachedEventOffline();
      } else if (isAccessDeniedError(message)) {
        setEventUnavailableReason("general");
        try {
          await redactCachedNotificationEventDetails(notification.id, userId, "unavailable");
          await refreshLocalCache(userId);
        } catch (cacheError) {
          setEventDetailsError(cacheError instanceof Error
            ? cacheError.message
            : "No se pudo sanear la copia local de la información.");
        }
      } else {
        setEventDetailsError(message || "No se pudo verificar el acceso a la información del evento.");
      }
    } finally {
      setOpeningEventId(null);
    }
  };

  useEffect(() => {
    const previous = previousConnectivityRef.current;
    const connectionRestored = (!previous.online && isConnectionAvailable)
      || (!previous.reachable && serverReachable);
    previousConnectivityRef.current = {
      online: isConnectionAvailable,
      reachable: serverReachable,
    };
    if (
      !connectionRestored
      || !eventDetailsOfflineSnapshot
      || !eventDetailsNotificationId
    ) return;

    let active = true;
    const notificationId = eventDetailsNotificationId;
    setOpeningEventId(notificationId);
    void (async () => {
      try {
        const result = await getNotificationEventDetailsWithTimeout(notificationId);
        if (!active) return;
        if (result.available && result.event.status !== "cancelled") {
          setEventToView(result.event);
          setEventDetailsOfflineSnapshot(false);
          setEventUnavailableReason(null);
          try {
            await cacheAuthorizedNotificationEventDetails(notificationId, userId, result.event);
            await refreshLocalCache(userId);
          } catch (cacheError) {
            setEventDetailsError(cacheError instanceof Error
              ? cacheError.message
              : "No se pudo actualizar la copia local de la información.");
          }
          return;
        }

        const accessState = result.available || result.reason === "cancelled"
          ? "cancelled"
          : result.reason === "unassigned" ? "unassigned"
            : result.reason === "deleted" ? "deleted" : "unavailable";
        setEventToView(null);
        setEventDetailsOfflineSnapshot(false);
        setEventUnavailableReason(result.available
          ? "cancelled"
          : result.reason === "cancelled"
            ? "cancelled"
            : result.reason === "unassigned" ? "unassigned"
              : result.reason === "deleted" ? "deleted" : "general");
        try {
          await redactCachedNotificationEventDetails(notificationId, userId, accessState);
          await refreshLocalCache(userId);
        } catch (cacheError) {
          setEventDetailsError(cacheError instanceof Error
            ? cacheError.message
            : "No se pudo sanear la copia local de la información.");
        }
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : "";
        if (isAccessDeniedError(message)) {
          setEventToView(null);
          setEventDetailsOfflineSnapshot(false);
          setEventUnavailableReason("general");
          try {
            await redactCachedNotificationEventDetails(notificationId, userId, "unavailable");
            await refreshLocalCache(userId);
          } catch (cacheError) {
            setEventDetailsError(cacheError instanceof Error
              ? cacheError.message
              : "No se pudo sanear la copia local de la información.");
          }
        } else if (!isConnectionError(message) && message !== "notification_access_check_timeout") {
          setEventToView(null);
          setEventDetailsOfflineSnapshot(false);
          setEventUnavailableReason("general");
        }
      } finally {
        if (active) setOpeningEventId(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    eventDetailsNotificationId,
    eventDetailsOfflineSnapshot,
    isConnectionAvailable,
    refreshLocalCache,
    serverReachable,
    userId,
  ]);

  const panelOperations: SyncPanelOperation[] = operations.map((operation: NotificationOutboxOperation) => ({
    id: operation.operationId,
    name: operation.notificationTitle
      ?? (notificationTitles.scope === identity?.scope ? notificationTitles.titles[operation.notificationId] : undefined)
      ?? notifications.find((item) => item.id === operation.notificationId)?.title
      ?? "Notificación",
    action: operation.kind === "read" ? "Marcado como leída" : "Eliminación",
    status: operation.status === "pending" ? "Sincronización pendiente" : "Requiere atención",
    error: operation.lastError,
  }));
  const displayedWarnings = [...new Set([
    isConnectionAvailable || !isConnectionError(displayedSyncError) ? displayedSyncError : "",
    isConnectionAvailable ? displayedRealtimeWarning : "",
    eventDetailsError,
  ].filter(Boolean))];
  const confirmedDeleteCount = deleteDialog?.ids
    .filter((id) => notifications.some((notification) => notification.id === id))
    .length ?? 0;

  return (
    <div className="notifications-page">
      <Sidebar />
      <main className="notifications-content">
        <header className="notifications-header">
          <div>
            <span className="notifications-eyebrow">Centro de avisos</span>
            <h1>Notificaciones</h1>
            <p>Mantente al día con tus actividades y novedades.</p>
          </div>
          <div className="notifications-header-actions">
            {unreadCount > 0 && <button type="button" className="notifications-read-all" onClick={() => { void handleMarkAllRead(); }}>Marcar todas como leídas</button>}
            <SyncStatusPanel
              title="Estado de Notificaciones"
              online={isConnectionAvailable}
              syncing={isSyncing}
              statusLabel={statusLabel}
              pendingCount={pendingCount}
              deletionCount={pendingDeletionCount}
              lastSuccessfulSyncAt={activeCache.savedAt}
              operations={panelOperations}
              warnings={displayedWarnings}
              onRefresh={() => { void syncAndRefresh(); }}
            />
          </div>
        </header>

        <section className="notifications-panel" aria-labelledby="notifications-list-title">
          <div className="notifications-panel-heading">
            <div><h2 id="notifications-list-title">Actividad reciente</h2><p>Consulta tus asignaciones, recordatorios y avisos importantes.</p></div>
            <div className="notifications-list-tools">
              <span className="notifications-count">
                {notifications.length} {notifications.length === 1 ? "aviso" : "avisos"}
                {unreadCount > 0 ? ` · ${unreadCount} nuevo${unreadCount === 1 ? "" : "s"}` : ""}
              </span>
              <button
                type="button"
                className="announcement-selection-toggle-button"
                onClick={() => {
                  setSelectionMode((active) => !active);
                  setSelectedIds([]);
                }}
              >
                <ListChecks size={17} aria-hidden="true" />
                <span>{selectionMode ? "Cancelar selección" : "Seleccionar notificaciones"}</span>
              </button>
              {selectionMode && (
                <button
                  type="button"
                  className="delete-announcements-button"
                  disabled={visibleSelectedIds.length === 0 || isDeleting}
                  onClick={() => {
                    if (visibleSelectedIds.length === 0) return;
                    setDeleteDialogError("");
                    setDeleteDialog({ ids: [...visibleSelectedIds], mode: "multiple" });
                  }}
                  aria-label={`Eliminar ${visibleSelectedIds.length} notificaciones seleccionadas`}
                >
                  <Trash2 size={18} aria-hidden="true" />
                  <span>Eliminar ({visibleSelectedIds.length})</span>
                </button>
              )}
            </div>
          </div>

          {selectionMode && notifications.length > 0 && (
            <div className="announcement-selection-bar">
              <label>
                <input
                  type="checkbox"
                  checked={allNotificationsSelected}
                  onChange={() => setSelectedIds(allNotificationsSelected
                    ? []
                    : notifications.map((notification) => notification.id))}
                />
                Seleccionar todas
              </label>
              {visibleSelectedIds.length > 0 && <span>{visibleSelectedIds.length} seleccionada{visibleSelectedIds.length === 1 ? "" : "s"}</span>}
            </div>
          )}

          {cacheLoadedScope !== identity?.scope ? (
            <div className="notifications-empty"><h3>Cargando notificaciones</h3></div>
          ) : !activeCache.notifications && !serverReachable ? (
            <div className="notifications-empty"><h3>No hay notificaciones guardadas para consultar</h3><p>Conéctate para cargar tus avisos.</p></div>
          ) : notifications.length === 0 ? (
            <div className="notifications-empty"><span className="notifications-empty-mark" aria-hidden="true"><Bell size={20} /></span><h3>No tienes notificaciones</h3><p>Los avisos generados por acciones importantes aparecerán aquí.</p></div>
          ) : (
            <div className="notifications-list">
              {notifications.map((notification: AppNotification) => {
                const meta = notificationLabels[notification.kind];
                const details = getNotificationDetails(notification);
                return (
                  <article className={`notification-item ${selectionMode ? "selection-mode" : ""} ${notification.readAt ? "is-read" : "is-unread"} ${visibleSelectedIds.includes(notification.id) ? "is-selected" : ""}`} key={notification.id}>
                    {selectionMode && <input className="notification-select" type="checkbox" checked={visibleSelectedIds.includes(notification.id)} onChange={() => setSelectedIds((ids) => visibleSelectedIds.includes(notification.id) ? ids.filter((id) => id !== notification.id) : [...visibleSelectedIds, notification.id])} aria-label={`Seleccionar ${notification.title}`} />}
                    <span className={`notification-marker marker-${meta.tone}`} aria-hidden="true">{getNotificationIcon(notification.kind)}</span>
                    <div className="notification-main">
                      <div className="notification-card-heading">
                        <div className="notification-topline"><span className={`notification-type type-${meta.tone}`}>{meta.label}</span><time>{new Date(notification.createdAt).toLocaleString("es-MX")}</time></div>
                        <span className={`notification-status ${notification.readAt ? "status-read" : "status-unread"}`}>{notification.readAt ? "Leída" : "Sin leer"}</span>
                      </div>
                      <h3>{getNotificationTitle(notification)}</h3>
                      <p>{notification.message}</p>
                      {notification.event && (
                        <div className="notification-event-details">
                          <span>{new Date(`${notification.event.date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })}</span>
                          <span>{notification.event.startTime} – {notification.event.endTime}</span>
                        </div>
                      )}
                      <div className="notification-actions">
                        {(details || notification.kind.startsWith("event_")) && <button type="button" className="notification-summary-button" onClick={() => {
                          if (notification.kind.startsWith("event_")) void handleViewEvent(notification);
                          else if (details && !("startTime" in details)) {
                            detailsModalOpenRef.current = true;
                            setDetailsToView(details);
                            setDetailsOfflineSnapshot(isUsingCachedDataOffline);
                          }
                        }} disabled={notification.kind.startsWith("event_") && openingEventId === notification.id}>
                          <Eye size={15} aria-hidden="true" />
                          <span>{openingEventId === notification.id ? "Consultando..." : "Ver información"}</span>
                        </button>}
                        {!notification.readAt && <button type="button" className="notification-mark-read" onClick={() => { void handleMarkRead(notification.id); }}>Marcar leída</button>}
                        <button
                          type="button"
                          className="notification-delete-one"
                          disabled={isDeleting}
                          onClick={() => {
                            setDeleteDialogError("");
                            setDeleteDialog({ ids: [notification.id], mode: "single", notificationTitle: notification.title });
                          }}
                          aria-label={`Eliminar ${notification.title}`}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
      {eventToView && (
        <EventSummaryDialog
          event={eventToView}
          isOfflineSnapshot={eventDetailsOfflineSnapshot}
          onClose={() => {
            setEventToView(null);
            setEventDetailsOfflineSnapshot(false);
            setEventDetailsNotificationId(null);
          }}
        />
      )}
      {eventUnavailableReason && (
        <EventSummaryDialog
          event={null}
          unavailableReason={eventUnavailableReason}
          onClose={() => {
            setEventUnavailableReason(null);
            setEventDetailsNotificationId(null);
          }}
        />
      )}
      {detailsToView && (
        <NotificationInfoDialog
          details={detailsToView}
          isOfflineSnapshot={detailsOfflineSnapshot}
          onClose={() => {
            detailsModalOpenRef.current = false;
            setDetailsToView(null);
            setDetailsOfflineSnapshot(false);
          }}
        />
      )}
      {deleteDialog && (
        <ConfirmDialog
          title={deleteDialog.mode === "single" ? "Eliminar notificación" : "Eliminar notificaciones"}
          message={deleteDialog.mode === "single"
            ? `¿Deseas eliminar la notificación "${deleteDialog.notificationTitle ?? "seleccionada"}"?`
            : `¿Deseas eliminar las ${confirmedDeleteCount} notificaciones seleccionadas?`}
          errorMessage={deleteDialogError}
          confirmLabel={deleteDialog.mode === "single" ? "Eliminar" : `Eliminar (${confirmedDeleteCount})`}
          isConfirming={isDeleting}
          onCancel={() => {
            if (isDeleting) return;
            setDeleteDialog(null);
            setDeleteDialogError("");
          }}
          onConfirm={() => { void handleConfirmDelete(); }}
        />
      )}
    </div>
  );
}

export default Notificaciones;
