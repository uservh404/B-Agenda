import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CalendarDays, Eye, ListChecks, Megaphone, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import SyncStatusPanel, { type SyncPanelOperation } from "../components/SyncStatusPanel";
import { useAuth } from "../auth/useAuth";
import {
  getAnnouncementCacheIdentity,
  mergeAnnouncementsWithOutbox,
  readAnnouncementCache,
  enqueueAnnouncementOperation,
  type AnnouncementCacheBundle,
  type AnnouncementCacheIdentity,
  type AnnouncementOperation,
} from "../services/announcement-offline-cache";
import {
  subscribeToAnnouncementChanges,
  removeAnnouncementChangesSubscription,
  type Announcement,
} from "../services/announcements";
import {
  synchronizeAnnouncements,
  type AnnouncementSyncResult,
} from "../services/announcement-offline-sync";
import { hasAdministrativePermission } from "../auth/auth-context";
import { markAnnouncementsAsSeen } from "../auth/announcement-reads";
import "./S-anuncios.css";

const emptyBundle: AnnouncementCacheBundle = {
  announcements: null,
  savedAt: null,
  operations: [],
  canPublishAnnouncements: null,
};
const emptyAnnouncements: Announcement[] = [];

type AnnouncementDeleteDialog = {
  mode: "single" | "multiple";
  announcementIds: string[];
  announcementTitle?: string;
};

type ActiveAnnouncementSync = {
  requested: boolean;
  promise: Promise<AnnouncementSyncResult>;
};

function getIdentity(userId: string | undefined) {
  if (!userId) return null;
  try {
    return getAnnouncementCacheIdentity(userId);
  } catch {
    return null;
  }
}

function Anuncios() {
  const { status, profile, user } = useAuth();
  const identity = useMemo(() => getIdentity(user?.id), [user?.id]);
  const [cache, setCache] = useState<AnnouncementCacheBundle>(emptyBundle);
  const [cacheLoadedScope, setCacheLoadedScope] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  const activeSyncsRef = useRef(new Map<string, ActiveAnnouncementSync>());
  const [serverState, setServerState] = useState<{ scope: string; reachable: boolean }>({ scope: "", reachable: false });
  const [syncErrorState, setSyncErrorState] = useState<{ scope: string; message: string } | null>(null);
  const [permissionErrorState, setPermissionErrorState] = useState<{ scope: string; message: string } | null>(null);
  const [realtimeWarningState, setRealtimeWarningState] = useState<{ scope: string; message: string } | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<Announcement | null>(null);
  const [searchText, setSearchText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const operationInProgress = useRef(false);
  const [selection, setSelection] = useState<{ scope: string | null; active: boolean; ids: string[] }>({
    scope: null,
    active: false,
    ids: [],
  });
  const [deleteDialog, setDeleteDialog] = useState<AnnouncementDeleteDialog | null>(null);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [announcementToView, setAnnouncementToView] = useState<Announcement | null>(null);
  const [formData, setFormData] = useState({ title: "", content: "", category: "" });

  const activeCache = identity && cacheLoadedScope === identity.scope ? cache : emptyBundle;
  const cachedAnnouncements = activeCache.announcements ?? emptyAnnouncements;
  const operations = activeCache.operations;
  const announcements = useMemo(
    () => mergeAnnouncementsWithOutbox(cachedAnnouncements, operations),
    [cachedAnnouncements, operations],
  );
  const displayedSyncError = syncErrorState && syncErrorState.scope === identity?.scope
    ? syncErrorState.message
    : "";
  const displayedPermissionError = permissionErrorState && permissionErrorState.scope === identity?.scope
    ? permissionErrorState.message
    : "";
  const displayedRealtimeWarning = realtimeWarningState && realtimeWarningState.scope === identity?.scope
    ? realtimeWarningState.message
    : "";
  const serverReachable = serverState.scope === identity?.scope && serverState.reachable;
  const isSyncing = syncingScope === identity?.scope;
  const isConnectionAvailable = isOnline && window.navigator.onLine;
  const isAdministrator = profile?.role === "administrador";
  const canPublish = isAdministrator
    || (status === "offline"
      ? activeCache.canPublishAnnouncements === true
      : hasAdministrativePermission(profile, "can_publish_announcements"));
  const selectionMatchesIdentity = !!identity && selection.scope === identity.scope;
  const selectedIds = canPublish && selectionMatchesIdentity ? selection.ids : [];
  const selectionMode = canPublish && selectionMatchesIdentity && selection.active;
  const selectedAnnouncements = announcements.filter((announcement) => selectedIds.includes(announcement.id));
  const pendingCount = operations.filter((operation) => operation.status === "pending").length;
  const pendingDeletionCount = operations.filter((operation) => operation.kind === "delete").length;
  const hasIssues = operations.some((operation) => operation.status !== "pending");
  const statusLabel = !isConnectionAvailable
    ? "Sin conexión"
    : isSyncing
      ? "Sincronizando"
      : hasIssues || !!displayedSyncError || !!displayedPermissionError || !!displayedRealtimeWarning
        ? "Requiere atención"
        : pendingCount > 0
          ? "Sincronización pendiente"
          : serverReachable ? "Todo sincronizado" : "Sincronización pendiente";
  const lastSuccessfulSyncAt = activeCache.savedAt;

  const replaceSelection = (active: boolean, ids: string[] = []) => {
    setSelection({ scope: identity?.scope ?? null, active, ids });
  };
  const updateSelectedIds = (update: (ids: string[]) => string[]) => {
    if (!identity) return;
    setSelection((current) => {
      const sameScope = current.scope === identity.scope;
      return {
        scope: identity.scope,
        active: sameScope && current.active,
        ids: update(sameScope ? current.ids : []),
      };
    });
  };

  const refreshLocalCache = useCallback(async (target: AnnouncementCacheIdentity) => {
    const next = await readAnnouncementCache(target);
    setCache(next);
    setCacheLoadedScope(target.scope);
    const latestCreatedAt = next.announcements
      ?.map((announcement) => announcement.createdAt)
      .sort()
      .at(-1) ?? null;
    markAnnouncementsAsSeen(target.userId, latestCreatedAt);
    return next;
  }, []);

  const synchronizeAndRefresh = useCallback((target: AnnouncementCacheIdentity): Promise<AnnouncementSyncResult> => {
    if (!window.navigator.onLine) {
      return Promise.resolve({ serverReachable: false });
    }

    const active = activeSyncsRef.current.get(target.scope);
    if (active) {
      active.requested = true;
      return active.promise;
    }

    const state: ActiveAnnouncementSync = {
      requested: false,
      promise: Promise.resolve({ serverReachable: false }),
    };
    activeSyncsRef.current.set(target.scope, state);
    setSyncingScope(target.scope);
    state.promise = (async () => {
      let result: AnnouncementSyncResult;
      do {
        state.requested = false;
        if (!window.navigator.onLine) {
          result = { serverReachable: false };
          break;
        }
        result = await synchronizeAnnouncements(target);
        setServerState({ scope: target.scope, reachable: result.serverReachable });
        setSyncErrorState({ scope: target.scope, message: result.error ?? "" });
        await refreshLocalCache(target);
      } while (state.requested && window.navigator.onLine && !result.error);
      return result;
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "No se pudo sincronizar Anuncios.";
      setServerState({ scope: target.scope, reachable: false });
      setSyncErrorState({ scope: target.scope, message });
      return { serverReachable: false, error: message };
    }).finally(() => {
      if (activeSyncsRef.current.get(target.scope) === state) {
        activeSyncsRef.current.delete(target.scope);
      }
      setSyncingScope((scope) => scope === target.scope ? null : scope);
    });
    return state.promise;
  }, [refreshLocalCache]);

  useEffect(() => {
    const updateConnection = () => {
      const online = window.navigator.onLine;
      setIsOnline(online);
      if (!online) {
        setServerState((current) => ({ ...current, reachable: false }));
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
    void readAnnouncementCache(identity).then((next) => {
      if (!active) return;
      setCache(next);
      setCacheLoadedScope(identity.scope);
    }).catch((error: unknown) => {
      if (!active) return;
      setSyncErrorState({
        scope: identity.scope,
        message: error instanceof Error ? error.message : "No se pudo leer la caché de Anuncios.",
      });
      setCacheLoadedScope(identity.scope);
    });
    return () => { active = false; };
  }, [identity]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isOnline || !window.navigator.onLine) return;
    void synchronizeAndRefresh(identity);
  }, [identity, cacheLoadedScope, isOnline, refreshSequence, synchronizeAndRefresh]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isOnline || !window.navigator.onLine || isSyncing) return;
    const intervalId = window.setInterval(() => {
      if (!window.navigator.onLine || activeSyncsRef.current.has(identity.scope)) return;
      void synchronizeAndRefresh(identity);
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [identity, cacheLoadedScope, isOnline, isSyncing, synchronizeAndRefresh]);

  useEffect(() => {
    if (!identity || status !== "authenticated" || !profile) return;
    let active = true;
    const channel = subscribeToAnnouncementChanges(
      identity.userId,
      () => {
        if (active && window.navigator.onLine) setRefreshSequence((value) => value + 1);
      },
      (channelStatus) => {
        if (!active) return;
        if (channelStatus === "SUBSCRIBED") {
          setRealtimeWarningState((current) => current?.scope === identity.scope ? null : current);
          if (window.navigator.onLine) setRefreshSequence((value) => value + 1);
        } else if (
          (channelStatus === "CHANNEL_ERROR" || channelStatus === "TIMED_OUT")
          && window.navigator.onLine
        ) {
          setRealtimeWarningState({
            scope: identity.scope,
            message: "Realtime de Anuncios no está disponible; la actualización periódica y manual siguen disponibles.",
          });
        }
      },
    );
    return () => {
      active = false;
      void removeAnnouncementChangesSubscription(channel);
    };
  }, [identity, status, profile]);

  const resetForm = () => {
    setFormData({ title: "", content: "", category: "" });
    setEditingAnnouncement(null);
  };

  const openCreateForm = () => {
    resetForm();
    setFormOpen((open) => !open);
  };

  const openEditForm = (announcement: Announcement) => {
    setEditingAnnouncement(announcement);
    setFormData({
      title: announcement.title,
      content: announcement.content,
      category: announcement.category,
    });
    setFormOpen(true);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operationInProgress.current) return;
    if (!canPublish || !identity || cacheLoadedScope !== identity.scope) {
      setPermissionErrorState({
        scope: identity?.scope ?? "",
        message: "No tienes permiso disponible para publicar anuncios. Se requiere conexión para verificarlo.",
      });
      return;
    }
    const title = formData.title.trim();
    const content = formData.content.trim();
    if (!title || !content) return;
    const existing = editingAnnouncement;
    const itemId = existing?.id ?? crypto.randomUUID();
    const operation: Omit<AnnouncementOperation, "scope" | "projectId" | "userId" | "status" | "createdAt" | "attempts"> = {
      operationId: crypto.randomUUID(),
      announcementId: itemId,
      kind: existing ? "update" : "create",
      expectedVersion: existing?.version ?? 0,
      input: { title, content, category: formData.category.trim() || "General" },
      previousAnnouncement: existing,
    };
    operationInProgress.current = true;
    setIsSaving(true);
    try {
      await enqueueAnnouncementOperation(identity, operation);
      await refreshLocalCache(identity);
      resetForm();
      setFormOpen(false);
      setPermissionErrorState({ scope: identity.scope, message: "" });
      if (window.navigator.onLine) await synchronizeAndRefresh(identity);
    } catch (error) {
      setSyncErrorState({
        scope: identity?.scope ?? "",
        message: error instanceof Error ? error.message : "No se pudo guardar el anuncio localmente.",
      });
    } finally {
      operationInProgress.current = false;
      setIsSaving(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteDialog) return;
    if (operationInProgress.current) return;
    if (!identity || !canPublish || cacheLoadedScope !== identity.scope) {
      setPermissionErrorState({
        scope: identity?.scope ?? "",
        message: "No tienes permiso disponible para eliminar anuncios.",
      });
      setDeleteDialogError("No se pudo confirmar el permiso para eliminar anuncios.");
      return;
    }
    const selected = announcements.filter((announcement) => deleteDialog.announcementIds.includes(announcement.id));
    if (selected.length === 0) {
      setDeleteDialog(null);
      setDeleteDialogError("");
      return;
    }

    operationInProgress.current = true;
    setIsSaving(true);
    const queuedIds: string[] = [];
    try {
      try {
        for (const announcement of selected) {
          await enqueueAnnouncementOperation(identity, {
            operationId: crypto.randomUUID(),
            announcementId: announcement.id,
            kind: "delete",
            expectedVersion: announcement.version,
            previousAnnouncement: announcement,
          });
          queuedIds.push(announcement.id);
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "No se pudieron guardar todas las eliminaciones localmente.";
        setSyncErrorState({ scope: identity.scope, message });
        if (queuedIds.length > 0) {
          const queued = new Set(queuedIds);
          const remainingIds = deleteDialog.announcementIds.filter((id) => !queued.has(id));
          updateSelectedIds((ids) => ids.filter((id) => !queued.has(id)));
          setDeleteDialog(remainingIds.length > 0 ? { ...deleteDialog, announcementIds: remainingIds } : null);
          if (remainingIds.length === 0 && deleteDialog.mode === "multiple") {
            replaceSelection(false);
          }
          try {
            await refreshLocalCache(identity);
          } catch (refreshError) {
            setSyncErrorState({
              scope: identity.scope,
              message: refreshError instanceof Error
                ? refreshError.message
                : "No se pudo actualizar la lista local de anuncios.",
            });
          }
        }
        setDeleteDialogError(message);
        return;
      }

      setDeleteDialog(null);
      setDeleteDialogError("");
      if (deleteDialog.mode === "multiple") {
        replaceSelection(false);
      } else {
        const deletedIds = new Set(selected.map((announcement) => announcement.id));
        updateSelectedIds((ids) => ids.filter((id) => !deletedIds.has(id)));
      }
      try {
        await refreshLocalCache(identity);
        if (window.navigator.onLine) await synchronizeAndRefresh(identity);
      } catch (error) {
        setSyncErrorState({
          scope: identity.scope,
          message: error instanceof Error ? error.message : "No se pudo actualizar la lista local de anuncios.",
        });
      }
    } finally {
      operationInProgress.current = false;
      setIsSaving(false);
    }
  };

  const filteredAnnouncements = announcements.filter((announcement) => {
    const query = searchText.toLowerCase().trim();
    return !query || `${announcement.title} ${announcement.content} ${announcement.category}`.toLowerCase().includes(query);
  });
  const allVisibleSelected = filteredAnnouncements.length > 0
    && filteredAnnouncements.every((announcement) => selectedIds.includes(announcement.id));
  const openMultipleDeleteConfirmation = () => {
    if (selectedAnnouncements.length === 0) return;
    setDeleteDialogError("");
    setDeleteDialog({
      mode: "multiple",
      announcementIds: selectedAnnouncements.map((announcement) => announcement.id),
    });
  };

  const panelOperations: SyncPanelOperation[] = operations.map((operation) => ({
    id: operation.operationId,
    name: operation.input?.title ?? operation.previousAnnouncement?.title ?? "Anuncio",
    action: operation.kind === "create" ? "Creación" : operation.kind === "update" ? "Modificación" : "Eliminación",
    status: operation.status === "pending" ? "Sincronización pendiente" : operation.status === "conflict" ? "Conflicto" : "Rechazado",
    error: operation.lastError,
  }));
  const permissionNotice = status === "authenticated" && !canPublish
    ? "No tienes permiso para publicar anuncios."
    : status === "offline" && !canPublish
      ? "No se pudo confirmar tu permiso sin conexión. Puedes consultar los anuncios guardados."
      : null;
  const warnings = [...new Set([
    displayedSyncError,
    displayedPermissionError,
    displayedRealtimeWarning,
    permissionNotice ?? "",
  ].filter(Boolean))];

  return (
    <div className="anuncios-page">
      <Sidebar />
      <main className="announcements-content">
        <header className="announcements-header">
          <div>
            <span className="announcements-eyebrow">Comunicación interna</span>
            <h1>Anuncios</h1>
            <p>Consulta y comparte avisos importantes con el equipo.</p>
          </div>
          <div className="announcement-header-actions">
            <SyncStatusPanel
              title="Estado de Anuncios"
              online={isConnectionAvailable}
              syncing={isSyncing}
              statusLabel={statusLabel}
              pendingCount={operations.length}
              deletionCount={pendingDeletionCount}
              lastSuccessfulSyncAt={lastSuccessfulSyncAt}
              operations={panelOperations}
              warnings={warnings}
              onRefresh={() => { if (identity) void synchronizeAndRefresh(identity); }}
            />
            {canPublish && (
              <button type="button" className="new-announcement-button" onClick={openCreateForm}>
                {formOpen ? "Cerrar" : "+ Crear anuncio"}
              </button>
            )}
          </div>
        </header>

        {canPublish && formOpen && (
          <form className="announcement-form" onSubmit={(event) => { void handleSubmit(event); }}>
            <div className="announcement-form-heading">
              <div><span className="announcements-eyebrow">{editingAnnouncement ? "Editar comunicado" : "Nuevo comunicado"}</span><h2>{editingAnnouncement ? "Modificar anuncio" : "Crear anuncio"}</h2></div>
              <Megaphone className="announcement-form-icon" aria-hidden="true" />
            </div>
            <label htmlFor="announcement-title">Título</label>
            <input id="announcement-title" value={formData.title} onChange={(event) => setFormData({ ...formData, title: event.target.value })} placeholder="Ej. Horario especial de atención" required />
            <label htmlFor="announcement-category">Categoría</label>
            <input id="announcement-category" value={formData.category} onChange={(event) => setFormData({ ...formData, category: event.target.value })} placeholder="Ej. Servicios, eventos, mantenimiento" />
            <label htmlFor="announcement-content">Mensaje</label>
            <textarea id="announcement-content" rows={4} value={formData.content} onChange={(event) => setFormData({ ...formData, content: event.target.value })} placeholder="Escribe la información que deseas compartir" required />
            <div className="announcement-form-actions">
              <button type="button" className="secondary-btn form-visual-cancel" disabled={isSaving} onClick={() => { resetForm(); setFormOpen(false); }}>Cancelar</button>
              <button type="submit" className="primary-btn form-visual-save" disabled={isSaving}>{isSaving ? "Guardando..." : editingAnnouncement ? "Guardar cambios" : "Publicar anuncio"}</button>
            </div>
          </form>
        )}

        <section className="announcements-panel" aria-label="Anuncios publicados">
          <div className="announcements-toolbar">
            <div><h2>Publicaciones recientes</h2><p>{canPublish ? "Comparte novedades con los usuarios de la biblioteca." : "Consulta las novedades publicadas por la biblioteca."}</p></div>
            <div className="announcement-list-tools">
              <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Buscar anuncios" aria-label="Buscar anuncios" />
              {canPublish && (
                <>
                  <button
                    type="button"
                    className="announcement-selection-toggle-button"
                    disabled={isSaving}
                    onClick={() => {
                      if (selectionMode) {
                        replaceSelection(false);
                      } else {
                        replaceSelection(true);
                      }
                    }}
                  >
                    <ListChecks size={17} aria-hidden="true" />
                    <span>{selectionMode ? "Cancelar selección" : "Seleccionar anuncios"}</span>
                  </button>
                  {selectionMode && (
                    <button
                      type="button"
                      className="delete-announcements-button"
                      disabled={selectedAnnouncements.length === 0 || isSaving}
                      onClick={openMultipleDeleteConfirmation}
                      aria-label={`Eliminar ${selectedAnnouncements.length} anuncios seleccionados`}
                    >
                      <Trash2 size={18} aria-hidden="true" />
                      <span>Eliminar ({selectedAnnouncements.length})</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {canPublish && selectionMode && announcements.length > 0 && (
            <div className="announcement-selection-bar">
              <label><input type="checkbox" checked={allVisibleSelected} onChange={() => updateSelectedIds((ids) => allVisibleSelected
                ? ids.filter((id) => !filteredAnnouncements.some((announcement) => announcement.id === id))
                : [...new Set([...ids, ...filteredAnnouncements.map((announcement) => announcement.id)])])} /> Seleccionar todos</label>
              {selectedAnnouncements.length > 0 && <span>{selectedAnnouncements.length} seleccionado{selectedAnnouncements.length > 1 ? "s" : ""}</span>}
            </div>
          )}

          {cacheLoadedScope !== identity?.scope ? (
            <div className="announcements-empty"><h3>Cargando anuncios</h3></div>
          ) : !activeCache.announcements && !serverReachable ? (
            <div className="announcements-empty"><h3>No hay anuncios guardados para consultar</h3><p>Conéctate para cargar las publicaciones.</p></div>
          ) : announcements.length === 0 ? (
            <div className="announcements-empty"><Megaphone aria-hidden="true" /><h3>Aún no hay anuncios</h3><p>Las publicaciones nuevas aparecerán aquí.</p></div>
          ) : filteredAnnouncements.length === 0 ? (
            <div className="announcements-empty"><h3>No encontramos anuncios</h3><p>Prueba con otra palabra de búsqueda.</p></div>
          ) : (
            <div className="announcement-list">
              {filteredAnnouncements.map((announcement) => {
                const pending = operations.some((operation) => operation.announcementId === announcement.id);
                return (
                  <article className="announcement-card" key={announcement.id}>
                    <div className="announcement-card-top">
                      {canPublish && selectionMode && <input className="announcement-checkbox" type="checkbox" checked={selectedIds.includes(announcement.id)} onChange={() => updateSelectedIds((ids) => ids.includes(announcement.id) ? ids.filter((id) => id !== announcement.id) : [...ids, announcement.id])} aria-label={`Seleccionar ${announcement.title}`} />}
                      <time>Publicado el {new Date(announcement.createdAt).toLocaleString("es-MX")}</time>
                    </div>
                    <span className="announcement-field-label">Título del anuncio</span>
                    <h3 title={announcement.title}>{announcement.title}</h3>
                    <p>{announcement.content}</p>
                    <div className="announcement-category-row">
                      <span className="announcement-field-label">Categoría</span>
                      <span className="announcement-category">{announcement.category}</span>
                      {pending && <span className="announcement-pending-state">Pendiente de sincronización</span>}
                    </div>
                    <div className="announcement-card-actions">
                      <button type="button" className="announcement-summary-button" onClick={() => setAnnouncementToView(announcement)} aria-label={`Ver información de ${announcement.title}`}>
                        <Eye size={16} aria-hidden="true" /><span>Ver información</span>
                      </button>
                      {canPublish && <button type="button" className="announcement-edit-button" onClick={() => openEditForm(announcement)} aria-label={`Modificar ${announcement.title}`}><Pencil size={15} aria-hidden="true" /><span>Modificar</span></button>}
                      {canPublish && (
                        <button
                          type="button"
                          className="announcement-card-delete-button"
                          disabled={isSaving}
                          onClick={() => {
                            setDeleteDialogError("");
                            setDeleteDialog({
                              mode: "single",
                              announcementIds: [announcement.id],
                              announcementTitle: announcement.title,
                            });
                          }}
                          aria-label={`Eliminar ${announcement.title}`}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span>Eliminar</span>
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

      {announcementToView && (
        <div className="announcement-summary-backdrop" onClick={() => setAnnouncementToView(null)}>
          <section className="announcement-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="announcement-summary-title" onClick={(event) => event.stopPropagation()}>
            <header className="announcement-summary-header">
              <span className="announcement-summary-icon" aria-hidden="true"><Megaphone size={22} /></span>
              <div><span className="announcements-eyebrow">Información del anuncio</span><h2 id="announcement-summary-title">{announcementToView.title}</h2></div>
              <button type="button" className="announcement-summary-close" onClick={() => setAnnouncementToView(null)} aria-label="Cerrar información">×</button>
            </header>
            <div className="announcement-summary-content">
              <div className="announcement-summary-meta">
                <div><span>Categoría</span><strong>{announcementToView.category}</strong></div>
                <div className="announcement-summary-published"><CalendarDays size={16} aria-hidden="true" /><span>Publicado el {new Date(announcementToView.createdAt).toLocaleString("es-MX")}</span></div>
                <div><span>Autor</span><strong>{announcementToView.authorName}</strong></div>
              </div>
              <section className="announcement-summary-message"><h3><MessageSquareText size={16} aria-hidden="true" /> Contenido</h3><p>{announcementToView.content}</p></section>
            </div>
            <footer className="announcement-summary-footer"><button type="button" onClick={() => setAnnouncementToView(null)}>Cerrar</button></footer>
          </section>
        </div>
      )}
      {deleteDialog && (
        <ConfirmDialog
          title={deleteDialog.mode === "single" ? "Eliminar anuncio" : "Eliminar anuncios"}
          message={deleteDialog.mode === "single"
            ? `¿Deseas eliminar «${deleteDialog.announcementTitle ?? "este anuncio"}»?`
            : `¿Deseas eliminar los ${deleteDialog.announcementIds.length} anuncios seleccionados?`}
          errorMessage={deleteDialogError}
          confirmLabel={deleteDialog.mode === "single" ? "Eliminar anuncio" : `Eliminar (${deleteDialog.announcementIds.length})`}
          isConfirming={isSaving}
          onCancel={() => {
            setDeleteDialog(null);
            setDeleteDialogError("");
          }}
          onConfirm={() => { void handleDeleteConfirmed(); }}
        />
      )}
    </div>
  );
}

export default Anuncios;
