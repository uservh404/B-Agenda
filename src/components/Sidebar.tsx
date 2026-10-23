import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BookOpen, Megaphone, Package, Settings, UsersRound } from "lucide-react";
import { getActiveUserId, isAdministrator } from "../auth/permissions";
import { getUnreadAnnouncementCount, subscribeToAnnouncementUpdates } from "../auth/announcement-reads";
import { getUnreadNotificationCount, subscribeToNotificationUpdates } from "../auth/notifications";
import "./S-sidebar.css";

function Sidebar() {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const administrator = isAdministrator();
  const currentUserId = getActiveUserId();
  const [unreadCounts, setUnreadCounts] = useState(() => ({
    announcements: getUnreadAnnouncementCount(currentUserId),
    notifications: getUnreadNotificationCount(currentUserId),
  }));

  useEffect(() => {
    const refreshUnreadCounts = () => {
      setUnreadCounts({
        announcements: getUnreadAnnouncementCount(currentUserId),
        notifications: getUnreadNotificationCount(currentUserId),
      });
    };
    const unsubscribeAnnouncements = subscribeToAnnouncementUpdates(refreshUnreadCounts);
    const unsubscribeNotifications = subscribeToNotificationUpdates(refreshUnreadCounts);
    return () => {
      unsubscribeAnnouncements();
      unsubscribeNotifications();
    };
  }, [currentUserId]);

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
          <h2>Biblioteca</h2>
          <ul className="sidebar-menu-list">
            <li className="sidebar-menu-item" onClick={() => navigate("/principal")}><BookOpen aria-hidden="true" /><span>Inicio</span></li>
            {administrator && <li className="sidebar-menu-item" onClick={() => navigate("/usuarios")}><UsersRound aria-hidden="true" /><span>Usuarios</span></li>}
            <li className="sidebar-menu-item" onClick={() => navigate("/recursos")}><Package aria-hidden="true" /><span>Recursos</span></li>
            <li className="sidebar-menu-item" onClick={() => navigate("/anuncios")}><Megaphone aria-hidden="true" /><span>Anuncios</span>{renderUnreadBadge(unreadCounts.announcements, "anuncios nuevos")}</li>
            <li className="sidebar-menu-item" onClick={() => navigate("/notificaciones")}><Bell aria-hidden="true" /><span>Notificaciones</span>{renderUnreadBadge(unreadCounts.notifications, "notificaciones nuevas")}</li>
            <li className="sidebar-menu-item" onClick={() => navigate("/configuracion")}><Settings aria-hidden="true" /><span>Configuración</span></li>
          </ul>
        </>
      )}
    </aside>
  );
}

export default Sidebar;