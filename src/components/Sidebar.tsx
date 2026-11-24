import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BookOpen, Megaphone, Package, Settings, UsersRound } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import {
  getUnreadAnnouncementCount,
  isAnnouncementUnread,
  notifyAnnouncementsUpdated,
  subscribeToAnnouncementUpdates,
  synchronizeRemoteAnnouncementReadVersions,
} from "../auth/announcement-reads";
import { getUnreadNotificationCount, subscribeToNotificationUpdates } from "../auth/notifications";
import {
  getNotificationCacheIdentity,
  removeNotificationChangesSubscription,
  subscribeToNotificationChanges,
  synchronizeNotifications,
} from "../auth/notifications";
import {
  listAnnouncements,
  subscribeToAnnouncementChanges,
  removeAnnouncementChangesSubscription,
} from "../services/announcements";
import { getAnnouncementCacheIdentity } from "../services/announcement-offline-cache";
import { synchronizeAnnouncements } from "../services/announcement-offline-sync";
import {
  flushPendingAnnouncementReadStates,
  subscribeToAnnouncementReadStateChanges,
  removeAnnouncementReadStateChangesSubscription,
} from "../services/announcement-read-state-sync";
import "./S-sidebar.css";

function Sidebar() {
  const navigate = useNavigate();
  const { profile, user, status: authStatus } = useAuth();
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
  const announcementCountRevision = useRef(0);
  const remoteReadRequestRevision = useRef(0);
  const publicationRefreshRevision = useRef(0);

  useEffect(() => {
    let active = true;
    const refreshUnreadCounts = () => {
      if (announcementUserId) {
        const requestRevision = ++announcementCountRevision.current;
        void getUnreadAnnouncementCount(announcementUserId).then((announcements) => {
          if (active && requestRevision === announcementCountRevision.current) {
            setUnreadCounts((current) => ({ ...current, announcements }));
          }
        }).catch((error: unknown) => {
          if (active && requestRevision === announcementCountRevision.current) {
            setNotificationError(error instanceof Error ? error.message : "No se pudo actualizar el contador de Anuncios.");
          }
        });
      } else {
        announcementCountRevision.current += 1;
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
    refreshUnreadCounts();
    const unsubscribeAnnouncements = subscribeToAnnouncementUpdates(refreshUnreadCounts);
    const unsubscribeNotifications = subscribeToNotificationUpdates(refreshUnreadCounts);
    const intervalId = window.setInterval(refreshUnreadCounts, 15000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
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
    const intervalId = window.setInterval(() => {
      if (!active) return;
      void synchronizeNotifications(identity).catch(() => undefined);
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      void removeNotificationChangesSubscription(channel);
    };
  }, [notificationUserId, isOnline, notificationIdentityResult]);

  useEffect(() => {
    if (!announcementUserId || !isOnline || window.location.pathname === "/anuncios") return;
    let identity;
    try {
      identity = getAnnouncementCacheIdentity(announcementUserId);
    } catch {
      return;
    }
    let active = true;
    let refreshRevision = 0;
    const channel = subscribeToAnnouncementChanges(
      announcementUserId,
      () => {
        if (!active) return;
        const requestRevision = ++refreshRevision;
        void synchronizeAnnouncements(identity).then((result) => {
          if (!active || requestRevision !== refreshRevision) return;
          if (result.dataReadConfirmed) publicationRefreshRevision.current += 1;
          const countRevision = ++announcementCountRevision.current;
          void getUnreadAnnouncementCount(announcementUserId).then((announcements) => {
            if (
              active
              && requestRevision === refreshRevision
              && countRevision === announcementCountRevision.current
            ) {
              setUnreadCounts((current) => ({ ...current, announcements }));
            }
          }).catch(() => undefined);
        }).catch(() => undefined);
      },
      () => undefined,
    );
    const refresh = () => {
      const requestRevision = ++refreshRevision;
      void synchronizeAnnouncements(identity).then((result) => {
        if (!active || requestRevision !== refreshRevision) return;
        if (result.dataReadConfirmed) publicationRefreshRevision.current += 1;
        const countRevision = ++announcementCountRevision.current;
        void getUnreadAnnouncementCount(announcementUserId).then((announcements) => {
          if (
            active
            && requestRevision === refreshRevision
            && countRevision === announcementCountRevision.current
          ) {
            setUnreadCounts((current) => ({ ...current, announcements }));
          }
        }).catch(() => undefined);
      }).catch(() => undefined);
    };
    const intervalId = window.setInterval(refresh, 15000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      void removeAnnouncementChangesSubscription(channel);
    };
  }, [announcementUserId, isOnline]);

  useEffect(() => {
    if (!announcementUserId || !isOnline) return;
    let identity;
    try {
      identity = getAnnouncementCacheIdentity(announcementUserId);
    } catch (error) {
      console.error("No se pudo preparar la sincronización de lecturas de Anuncios.", error);
      return;
    }

    let active = true;
    const refreshRemoteReadCount = async () => {
      const requestRevision = ++remoteReadRequestRevision.current;
      const publicationRevisionAtStart = publicationRefreshRevision.current;
      announcementCountRevision.current += 1;
      let confirmedAnnouncements: Awaited<ReturnType<typeof listAnnouncements>> | null = null;
      try {
        confirmedAnnouncements = await listAnnouncements(announcementUserId);
        if (!active || requestRevision !== remoteReadRequestRevision.current) return;
        const currentVersions = Object.fromEntries(
          confirmedAnnouncements.map((announcement) => [announcement.id, announcement.version]),
        );
        try {
          await synchronizeRemoteAnnouncementReadVersions(
            announcementUserId,
            currentVersions,
          );
        } catch (error) {
          if (active) {
            console.warn("No se pudieron reconciliar las lecturas remotas de Anuncios.", error);
          }
        }
      } catch (error) {
        if (active) {
          console.warn("No se pudo obtener el snapshot confirmado de Anuncios.", error);
        }
      }

      if (
        !active
        || requestRevision !== remoteReadRequestRevision.current
        || publicationRevisionAtStart !== publicationRefreshRevision.current
      ) return;
      try {
        const announcements = confirmedAnnouncements
          ? confirmedAnnouncements.filter((announcement) =>
            isAnnouncementUnread(
              announcementUserId,
              announcement.id,
              announcement.createdAt,
              announcement.version,
            ),
          ).length
          : await getUnreadAnnouncementCount(announcementUserId);
        const countRevision = ++announcementCountRevision.current;
        if (
          active
          && requestRevision === remoteReadRequestRevision.current
          && publicationRevisionAtStart === publicationRefreshRevision.current
          && countRevision === announcementCountRevision.current
        ) {
          setUnreadCounts((current) => ({ ...current, announcements }));
        }
      } catch (error) {
        if (active) {
          console.error("No se pudo actualizar el contador local de Anuncios.", error);
        }
      }
    };

    const channel = subscribeToAnnouncementReadStateChanges(
      identity,
      () => {
        if (active) void refreshRemoteReadCount();
      },
      (status) => {
        if (active && status !== "SUBSCRIBED" && status !== "CLOSED") {
          console.warn(`Realtime de lecturas de Anuncios reportó ${status}.`);
        }
      },
    );
    void refreshRemoteReadCount();

    return () => {
      active = false;
      remoteReadRequestRevision.current += 1;
      void removeAnnouncementReadStateChangesSubscription(channel);
    };
  }, [announcementUserId, isOnline]);

  useEffect(() => {
    if (
      authStatus !== "authenticated"
      || !announcementUserId
      || !isOnline
      || !window.navigator.onLine
    ) return;

    let identity;
    try {
      identity = getAnnouncementCacheIdentity(announcementUserId);
    } catch (error) {
      console.error("No se pudo preparar el reintento de lecturas de Anuncios.", error);
      return;
    }

    let active = true;
    const flushPendingReads = async () => {
      try {
        const result = await flushPendingAnnouncementReadStates(identity);
        if (!active) return;
        if (result.synced.length > 0 || result.stale.length > 0) {
          notifyAnnouncementsUpdated();
        }
        if (result.issues.length > 0 || result.reason) {
          console.warn("El reintento de lecturas de Anuncios quedó incompleto.", result);
        }
      } catch (error) {
        if (active) {
          console.error("No se pudieron reintentar las lecturas pendientes de Anuncios.", error);
        }
      }
    };

    void flushPendingReads();
    return () => {
      active = false;
    };
  }, [announcementUserId, authStatus, isOnline]);

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