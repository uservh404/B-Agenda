import { useEffect, useState, type FormEvent } from "react";
import { CalendarDays, Eye, Megaphone, MessageSquareText, Trash2, X } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import { getActiveUserId } from "../auth/permissions";
import { useAuth } from "../auth/useAuth";
import { markAnnouncementsAsSeen, notifyAnnouncementsUpdated, subscribeToAnnouncementUpdates } from "../auth/announcement-reads";
import "./S-anuncios.css";

interface Announcement {
  id: number;
  title: string;
  content: string;
  category: string;
  date: string;
  time?: string;
}

const announcementsStorageKey = "biblioteca-announcements";

function readAnnouncements(): Announcement[] {
  try {
    const storedAnnouncements = window.localStorage.getItem(announcementsStorageKey);
    return storedAnnouncements ? JSON.parse(storedAnnouncements) as Announcement[] : [];
  } catch {
    return [];
  }
}

function Anuncios() {
  const { status, profile, error: authError } = useAuth();
  const administrator = profile?.role === "administrador";
  const activeUserId = getActiveUserId();
  const [announcements, setAnnouncements] = useState<Announcement[]>(readAnnouncements);
  const [formOpen, setFormOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [saved, setSaved] = useState(false);
  const [actionMessage, setActionMessage] = useState("El anuncio se publicó correctamente.");
  const [selectedAnnouncementIds, setSelectedAnnouncementIds] = useState<number[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [announcementToView, setAnnouncementToView] = useState<Announcement | null>(null);
  const [formData, setFormData] = useState({ title: "", content: "", category: "" });
  const canPublish = status === "authenticated" && profile?.can_publish_announcements === true;
  const permissionMessage = status === "loading"
    ? "Consultando tu permiso de publicación..."
    : status === "error" || (status === "authenticated" && !profile)
      ? authError ?? "No se pudo consultar tu permiso de publicación. La publicación está bloqueada."
      : status === "unauthenticated" || status === "recovery"
        ? "Inicia sesión para consultar tu permiso de publicación. La publicación está bloqueada."
        : status === "authenticated" && profile?.can_publish_announcements === false
          ? "No tienes permiso para publicar anuncios."
          : null;

  const resetAnnouncementForm = () => {
    setFormData({ title: "", content: "", category: "" });
  };

  const toggleAnnouncementForm = () => {
    if (formOpen) resetAnnouncementForm();
    setFormOpen((open) => !open);
    setSaved(false);
  };

  useEffect(() => {
    const syncAnnouncements = () => setAnnouncements(readAnnouncements());
    const unsubscribe = subscribeToAnnouncementUpdates(syncAnnouncements);
    markAnnouncementsAsSeen(activeUserId);
    return unsubscribe;
  }, [activeUserId]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canPublish) {
      setActionMessage("No tienes permiso para publicar anuncios.");
      setSaved(true);
      return;
    }

    const announcement: Announcement = {
      id: Date.now(),
      title: formData.title.trim(),
      content: formData.content.trim(),
      category: formData.category.trim() || "General",
      date: new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }),
      time: new Date().toLocaleTimeString("es-ES", { hour: "numeric", minute: "2-digit", hour12: true }),
    };
    const updatedAnnouncements = [announcement, ...announcements];
    setAnnouncements(updatedAnnouncements);
    window.localStorage.setItem(announcementsStorageKey, JSON.stringify(updatedAnnouncements));
    notifyAnnouncementsUpdated();
    markAnnouncementsAsSeen(activeUserId);
    setFormData({ title: "", content: "", category: "" });
    setFormOpen(false);
    setActionMessage("El anuncio se publicó correctamente.");
    setSaved(true);
  };

  const filteredAnnouncements = announcements.filter((announcement) => {
    const query = searchText.toLowerCase().trim();
    return !query || `${announcement.title} ${announcement.content} ${announcement.category}`.toLowerCase().includes(query);
  });
  const allVisibleSelected = filteredAnnouncements.length > 0 && filteredAnnouncements.every((announcement) => selectedAnnouncementIds.includes(announcement.id));

  const toggleAnnouncement = (id: number) => {
    setSelectedAnnouncementIds((selectedIds) => selectedIds.includes(id) ? selectedIds.filter((selectedId) => selectedId !== id) : [...selectedIds, id]);
  };

  const toggleAllVisible = () => {
    setSelectedAnnouncementIds((selectedIds) => {
      if (allVisibleSelected) return selectedIds.filter((id) => !filteredAnnouncements.some((announcement) => announcement.id === id));
      return [...new Set([...selectedIds, ...filteredAnnouncements.map((announcement) => announcement.id)])];
    });
  };

  const deleteSelectedAnnouncements = () => {
    const updatedAnnouncements = announcements.filter((announcement) => !selectedAnnouncementIds.includes(announcement.id));
    setAnnouncements(updatedAnnouncements);
    window.localStorage.setItem(announcementsStorageKey, JSON.stringify(updatedAnnouncements));
    notifyAnnouncementsUpdated();
    setSelectedAnnouncementIds([]);
    setDeleteDialogOpen(false);
    setActionMessage("Los anuncios seleccionados se eliminaron correctamente.");
    setSaved(true);
  };

  return (
    <div className="anuncios-page">
      <Sidebar />
      <main className="announcements-content">
        <header className="announcements-header">
          <div>
            <span className="announcements-eyebrow">Comunicación de la biblioteca</span>
            <h1>Anuncios</h1>
            <p>Información importante y novedades para toda la comunidad.</p>
          </div>
          <div className="announcement-header-actions">
            {canPublish && <button type="button" className="new-announcement-button" onClick={toggleAnnouncementForm}>{formOpen ? "Cerrar" : "+ Crear anuncio"}</button>}
          </div>
        </header>

        {permissionMessage && <p className="announcement-permission-error" role="alert">{permissionMessage}</p>}
        {saved && <p className="announcement-success" role="status">✓ {actionMessage}</p>}

        {canPublish && formOpen && (
          <form className="announcement-form" onSubmit={handleSubmit}>
            <div className="announcement-form-heading">
              <div><span className="announcements-eyebrow">Nuevo comunicado</span><h2>Crear anuncio</h2></div>
              <Megaphone className="announcement-form-icon" aria-hidden="true" />
            </div>
            <label htmlFor="announcement-title">Título</label>
            <input id="announcement-title" value={formData.title} onChange={(event) => setFormData({ ...formData, title: event.target.value })} placeholder="Ej. Horario especial de atención" required />
            <label htmlFor="announcement-category">Categoría</label>
            <input id="announcement-category" value={formData.category} onChange={(event) => setFormData({ ...formData, category: event.target.value })} placeholder="Ej. Servicios, eventos, mantenimiento" />
            <label htmlFor="announcement-content">Mensaje</label>
            <textarea id="announcement-content" rows={4} value={formData.content} onChange={(event) => setFormData({ ...formData, content: event.target.value })} placeholder="Escribe la información que deseas compartir" required />
            <button type="submit">Publicar anuncio</button>
          </form>
        )}

        <section className="announcements-panel" aria-label="Anuncios publicados">
          <div className="announcements-toolbar">
            <div><h2>Publicaciones recientes</h2><p>{canPublish ? "Comparte novedades con los usuarios de la biblioteca." : "Consulta las novedades publicadas por la biblioteca."}</p></div>
            <div className="announcement-list-tools">
              <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Buscar anuncios" aria-label="Buscar anuncios" />
              {administrator && <button type="button" className="delete-announcements-button" disabled={selectedAnnouncementIds.length === 0} onClick={() => setDeleteDialogOpen(true)} title="Eliminar anuncios seleccionados" aria-label="Eliminar anuncios seleccionados"><Trash2 size={20} strokeWidth={2.2} aria-hidden="true" /><span>{selectedAnnouncementIds.length > 0 ? selectedAnnouncementIds.length : ""}</span></button>}
            </div>
          </div>

          {administrator && announcements.length > 0 && (
            <div className="announcement-selection-bar">
              <label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> Seleccionar todos</label>
              {selectedAnnouncementIds.length > 0 && <span>{selectedAnnouncementIds.length} seleccionado{selectedAnnouncementIds.length > 1 ? "s" : ""}</span>}
            </div>
          )}

          {announcements.length === 0 ? (
            <div className="announcements-empty"><Megaphone aria-hidden="true" /><h3>Aún no hay anuncios</h3><p>Las publicaciones nuevas aparecerán aquí.</p></div>
          ) : filteredAnnouncements.length === 0 ? (
            <div className="announcements-empty"><span>⌕</span><h3>No encontramos anuncios</h3><p>Prueba con otra palabra de búsqueda.</p></div>
          ) : (
            <div className="announcement-list">
              {filteredAnnouncements.map((announcement) => (
                <article className="announcement-card" key={announcement.id}>
                  <div className="announcement-card-top">
                    {administrator && <input className="announcement-checkbox" type="checkbox" checked={selectedAnnouncementIds.includes(announcement.id)} onChange={() => toggleAnnouncement(announcement.id)} aria-label={`Seleccionar ${announcement.title}`} />}
                    <time>Publicado el {announcement.date} {announcement.time && `a las ${announcement.time}`}</time>
                  </div>
                  <span className="announcement-field-label">Título del anuncio</span>
                  <h3 title={announcement.title}>{announcement.title}</h3>
                  <p>{announcement.content}</p>
                  <div className="announcement-category-row">
                    <span className="announcement-field-label">Categoría</span>
                    <span className="announcement-category">{announcement.category}</span>
                  </div>
                  <div className="announcement-card-actions">
                    <button type="button" className="announcement-summary-button" onClick={() => setAnnouncementToView(announcement)} aria-label={`Ver resumen de ${announcement.title}`}>
                      <Eye size={16} aria-hidden="true" />
                      <span>Ver resumen</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {announcementToView && (
        <div className="announcement-summary-backdrop" onClick={() => setAnnouncementToView(null)}>
          <section className="announcement-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="announcement-summary-title" onClick={(event) => event.stopPropagation()}>
            <header className="announcement-summary-header">
              <span className="announcement-summary-icon" aria-hidden="true"><Megaphone size={22} /></span>
              <div>
                <span className="announcements-eyebrow">Resumen del anuncio</span>
                <h2 id="announcement-summary-title">{announcementToView.title}</h2>
              </div>
              <button type="button" className="announcement-summary-close" onClick={() => setAnnouncementToView(null)} aria-label="Cerrar resumen"><X size={19} /></button>
            </header>
            <div className="announcement-summary-content">
              <div className="announcement-summary-meta">
                <div><span>Categoría</span><strong>{announcementToView.category}</strong></div>
                <div className="announcement-summary-published">
                  <CalendarDays size={16} aria-hidden="true" />
                  <span>Publicado el {announcementToView.date}{announcementToView.time ? ` a las ${announcementToView.time}` : ""}</span>
                </div>
              </div>
              <section className="announcement-summary-message">
                <h3><MessageSquareText size={16} aria-hidden="true" /> Mensaje</h3>
                <p>{announcementToView.content}</p>
              </section>
            </div>
            <footer className="announcement-summary-footer">
              <button type="button" onClick={() => setAnnouncementToView(null)}>Cerrar</button>
            </footer>
          </section>
        </div>
      )}
      {deleteDialogOpen && <ConfirmDialog title="Eliminar anuncios" message={`¿Deseas eliminar ${selectedAnnouncementIds.length} anuncio${selectedAnnouncementIds.length > 1 ? "s" : ""}? Esta acción no se puede deshacer.`} onCancel={() => setDeleteDialogOpen(false)} onConfirm={deleteSelectedAnnouncements} />}
    </div>
  );
}

export default Anuncios;
