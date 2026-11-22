import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BookOpen, Megaphone, Package, Settings, UsersRound } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { getUnreadAnnouncementCount, subscribeToAnnouncementUpdates } from "../auth/announcement-reads";
import { getUnreadNotificationCount, subscribeToNotificationUpdates } from "../auth/notifications";
import {
  getNotificationCacheIdentity,
  removeNotificationChangesSubscription,
  subscribeToNotificationChanges,
  synchronizeNotifications,
} from "../auth/notifications";
import "./S-sidebar.css";

function Sidebar() {
  const navigate = useNavigate();
  const { profile, user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const administrator = profile?.role === "administrador";
  const announcementUserId = user?.id ?? "";
  const notificationUserId = user?.id ?? "";
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const notificationIdentityResult = useMemo(() => {
    if (!notificationUserId) return { identity: null, error: "" };
    try {
      return { identity: getNotificationCacheIdentity(notificationUserId), error: "" };
    } catch (error) {
      return {
        identity: null,
        error: error instanceof Error ? error.message : "No se pudo preparar la actualización de Notificaciones.",
      };
    }
  }, [notificationUserId]);
  const [unreadCounts, setUnreadCounts] = useState(() => ({
    announcements: 0,
    notifications: 0,
  }));

  useEffect(() => {
    const refreshUnreadCounts = () => {
      if (announcementUserId) {
        void getUnreadAnnouncementCount(announcementUserId).then((announcements) => {
          setUnreadCounts((current) => ({ ...current, announcements }));
        }).catch((error: unknown) => {
          setNotificationError(error instanceof Error ? error.message : "No se pudo actualizar el contador de Anuncios.");
        });
      } else {
        setUnreadCounts((current) => ({ ...current, announcements: 0 }));
      }
      if (notificationUserId) {
        void getUnreadNotificationCount(notificationUserId).then((notifications) => {
          setNotificationError("");
          setUnreadCounts((current) => ({ ...current, notifications }));
        }).catch(() => setNotificationError("No se pudo actualizar el contador de Notificaciones."));
      } else {
        setUnreadCounts((current) => ({ ...current, notifications: 0 }));
      }
    };
    const unsubscribeAnnouncements = subscribeToAnnouncementUpdates(refreshUnreadCounts);
    const unsubscribeNotifications = subscribeToNotificationUpdates(refreshUnreadCounts);
    return () => {
      unsubscribeAnnouncements();
      unsubscribeNotifications();
    };
  }, [announcementUserId, notificationUserId]);

  useEffect(() => {
    const updateConnection = () => setIsOnline(window.navigator.onLine);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!notificationUserId || !isOnline || !notificationIdentityResult.identity) return;
    let active = true;
    const identity = notificationIdentityResult.identity;
    const channel = subscribeToNotificationChanges(
      notificationUserId,
      () => {
        if (!active) return;
        void synchronizeNotifications(identity).then((result) => {
          if (result.error) setNotificationError(result.error);
          else setNotificationError("");
        }).catch((error: unknown) => {
          setNotificationError(error instanceof Error ? error.message : "No se pudieron actualizar las Notificaciones.");
        });
      },
      (channelStatus) => {
        if (active && channelStatus === "CHANNEL_ERROR") {
          setNotificationError("Realtime de Notificaciones no está disponible.");
        }
      },
    );
    return () => {
      active = false;
      void removeNotificationChangesSubscription(channel);
    };
  }, [notificationUserId, isOnline, notificationIdentityResult]);

  const renderUnreadBadge = (count: number, label: string) => count > 0 && (
    <span className="sidebar-unread-badge" aria-label={`${count} ${label} sin revisar`} title={`${count} ${label} sin revisar`}>
      {count > 99 ? "99+" : count}
    </span>
  );

  return (
    <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <button
        className="menu-button"
        onClick={() => setSidebarOpen((isOpen) => !isOpen)}
        aria-label="Abrir o cerrar menú"
      >
        {sidebarOpen ? "✕" : "☰"}
      </button>

      {sidebarOpen && (
        <>
          <h2>Menú</h2>
          <ul className="sidebar-menu-list">
            <li className="sidebar-menu-item" onClick={() => navigate("/principal")}><BookOpen aria-hidden="true" /><span>Inicio</span></li>
            {administrator && <li className="sidebar-menu-item" onClick={() => navigate("/usuarios")}><UsersRound aria-hidden="true" /><span>Usuarios</span></li>}
            <li className="sidebar-menu-item" onClick={() => navigate("/recursos")}><Package aria-hidden="true" /><span>Recursos</span></li>
            <li className="sidebar-menu-item" onClick={() => navigate("/anuncios")}><Megaphone aria-hidden="true" /><span>Anuncios</span>{renderUnreadBadge(unreadCounts.announcements, "anuncios nuevos")}</li>
            <li className="sidebar-menu-item" onClick={() => navigate("/notificaciones")}><Bell aria-hidden="true" /><span>Notificaciones</span>{renderUnreadBadge(unreadCounts.notifications, "notificaciones nuevas")}</li>
            <li className="sidebar-menu-item" onClick={() => navigate("/configuracion")}><Settings aria-hidden="true" /><span>Configuración</span></li>
          </ul>
          {(notificationError || notificationIdentityResult.error) && <p className="sidebar-auth-error" role="status">{notificationError || notificationIdentityResult.error}</p>}
        </>
      )}
    </aside>
  );
}

export default Sidebar;