import { useEffect, useState } from "react";
import { Eye, Trash2 } from "lucide-react";
import Sidebar from "../components/Sidebar";
import EventSummaryDialog from "../components/EventSummaryDialog";
import { getActiveUserId } from "../auth/permissions";
import {
  deleteNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  readNotificationsForUser,
  subscribeToNotificationUpdates,
  type AppNotification,
  type NotificationEventDetails,
  type NotificationKind,
} from "../auth/notifications";
import { readUsers } from "../auth/users";
import "./S-notificaciones.css";

const notificationLabels: Record<NotificationKind, { label: string; tone: string }> = {
  event_assigned: { label: "Evento asignado", tone: "blue" },
  event_updated: { label: "Evento actualizado", tone: "amber" },
  event_unassigned: { label: "Cambio de asignación", tone: "amber" },
  event_cancelled: { label: "Evento cancelado", tone: "red" },
  permission_granted: { label: "Permiso habilitado", tone: "green" },
  permission_revoked: { label: "Permiso revocado", tone: "red" },
};

function Notificaciones() {
  const currentUserId = getActiveUserId();
  const currentUser = readUsers().find((user) => user.id === currentUserId);
  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    readNotificationsForUser(currentUserId),
  );
  const [selectedNotificationIds, setSelectedNotificationIds] = useState<string[]>([]);
  const [eventToView, setEventToView] = useState<NotificationEventDetails | null>(null);
  const unreadCount = notifications.filter((notification) => !notification.readAt && !notification.isCurrentAssignment).length;
  const allNotificationsSelected = notifications.length > 0 && notifications.every((notification) => selectedNotificationIds.includes(notification.id));

  useEffect(() => {
    const refreshNotifications = () => {
      setNotifications(readNotificationsForUser(currentUserId));
    };
    const unsubscribe = subscribeToNotificationUpdates(refreshNotifications);
    markAllNotificationsRead(currentUserId);
    refreshNotifications();
    return unsubscribe;
  }, [currentUserId]);

  const handleMarkRead = (notificationId: string) => {
    markNotificationRead(notificationId);
  };

  const handleMarkAllRead = () => {
    markAllNotificationsRead(currentUserId);
  };

  const toggleNotificationSelection = (notificationId: string) => {
    setSelectedNotificationIds((selectedIds) => selectedIds.includes(notificationId)
      ? selectedIds.filter((id) => id !== notificationId)
      : [...selectedIds, notificationId]);
  };

  const toggleAllNotifications = () => {
    setSelectedNotificationIds((selectedIds) => allNotificationsSelected
      ? selectedIds.filter((id) => !notifications.some((notification) => notification.id === id))
      : [...new Set([...selectedIds, ...notifications.map((notification) => notification.id)])]);
  };

  const handleDeleteSelected = () => {
    deleteNotificationsForUser(currentUserId, selectedNotificationIds);
    setSelectedNotificationIds([]);
  };

  const formatTimestamp = (timestamp: string) => new Date(timestamp).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  const formatEventDate = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("es-MX", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  const formatEventTime = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString("es-MX", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  const eventEndsNextDay = (startTime: string, endTime: string) => {
    const [startHours, startMinutes] = startTime.split(":").map(Number);
    const [endHours, endMinutes] = endTime.split(":").map(Number);
    return endHours * 60 + endMinutes < startHours * 60 + startMinutes;
  };

  return (
    <div className="notifications-page">
      <Sidebar />
      <main className="notifications-content">
        <header className="notifications-header">
          <div>
            <span className="notifications-eyebrow">Agenda personal</span>
            <h1>Notificaciones</h1>
            <p>{currentUser ? `Avisos para ${currentUser.name}.` : "Avisos relacionados con tus eventos y permisos."}</p>
          </div>
          {unreadCount > 0 && (
            <button type="button" className="notifications-read-all" onClick={handleMarkAllRead}>
              Marcar todas como leídas
            </button>
          )}
        </header>

        <section className="notifications-panel" aria-labelledby="notifications-list-title">
          <div className="notifications-panel-heading">
            <div>
              <h2 id="notifications-list-title">Actividad reciente</h2>
              <p>Cambios reales en tus asignaciones y permisos.</p>
            </div>
            <span className="notifications-count">
              {notifications.length} {notifications.length === 1 ? "aviso" : "avisos"}
              {unreadCount > 0 ? ` · ${unreadCount} nuevo${unreadCount === 1 ? "" : "s"}` : ""}
            </span>
          </div>

          {notifications.length > 0 && (
            <div className="notifications-selection-toolbar">
              <label>
                <input type="checkbox" checked={allNotificationsSelected} onChange={toggleAllNotifications} />
                <span>Seleccionar todas</span>
              </label>
              <button type="button" className="notifications-delete-selected" disabled={selectedNotificationIds.length === 0} onClick={handleDeleteSelected}>
                <Trash2 size={16} aria-hidden="true" />
                <span>Eliminar seleccionadas{selectedNotificationIds.length > 0 ? ` (${selectedNotificationIds.length})` : ""}</span>
              </button>
            </div>
          )}

          {notifications.length === 0 ? (
            <div className="notifications-empty">
              <span className="notifications-empty-mark" aria-hidden="true">✓</span>
              <h3>No tienes notificaciones</h3>
              <p>Tus notificaciones apareceran aqui.</p>
            </div>
          ) : (
            <div className="notifications-list">
              {notifications.map((notification) => {
                const meta = notificationLabels[notification.kind];
                return (
                  <article className={`notification-item ${notification.readAt ? "is-read" : "is-unread"} ${selectedNotificationIds.includes(notification.id) ? "is-selected" : ""}`} key={notification.id}>
                    <input
                      className="notification-select"
                      type="checkbox"
                      checked={selectedNotificationIds.includes(notification.id)}
                      onChange={() => toggleNotificationSelection(notification.id)}
                      aria-label={`Seleccionar ${notification.title}`}
                    />
                    <span className={`notification-marker marker-${meta.tone}`} aria-hidden="true" />
                    <div className="notification-main">
                      <div className="notification-topline">
                        <span className={`notification-type type-${meta.tone}`}>{meta.label}</span>
                        {notification.createdAt && <time>{formatTimestamp(notification.createdAt)}</time>}
                      </div>
                      <h3>{notification.title}</h3>
                      <p>{notification.message}</p>
                      {notification.event && (
                        <div className="notification-event-details">
                          <span>{formatEventDate(notification.event.date)}</span>
                          {notification.event.startTime && notification.event.endTime && (
                            <span>
                              {formatEventTime(notification.event.startTime)} - {formatEventTime(notification.event.endTime)}
                              {eventEndsNextDay(notification.event.startTime, notification.event.endTime) && " · día siguiente"}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="notification-actions">
                      {notification.event && (
                        <button type="button" className="notification-summary-button" onClick={() => setEventToView(notification.event!)}>
                          <Eye size={15} aria-hidden="true" />
                          <span>Resumen</span>
                        </button>
                      )}
                      <span className={`notification-status status-${notification.readAt ? "read" : meta.tone}`}>
                        {notification.isCurrentAssignment ? "En tu agenda" : notification.readAt ? "Leída" : "Nueva"}
                      </span>
                      {!notification.readAt && !notification.isCurrentAssignment && (
                        <button type="button" className="notification-mark-read" onClick={() => handleMarkRead(notification.id)}>
                          Marcar leída
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
      {eventToView && <EventSummaryDialog event={eventToView} onClose={() => setEventToView(null)} />}
    </div>
  );
}

export default Notificaciones;