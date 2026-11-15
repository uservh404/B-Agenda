import { useEffect } from "react";
import { BellRing, CalendarDays, CalendarX2, Clock3, FileText, Tag, UserRound, UsersRound, X } from "lucide-react";
import type { NotificationEventDetails } from "../auth/notifications";
import "./S-event-summary.css";

interface EventSummaryDialogProps {
  event: NotificationEventDetails | null;
  onClose: () => void;
  unavailableReason?: "cancelled" | "unassigned" | "deleted" | "offline" | "general";
  isOfflineSnapshot?: boolean;
}

const reminderLabels = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["día", "días"],
  weeks: ["semana", "semanas"],
} as const;

function EventSummaryDialog({
  event,
  onClose,
  unavailableReason = "general",
  isOfflineSnapshot = false,
}: EventSummaryDialogProps) {
  useEffect(() => {
    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!event) {
    const notice = unavailableReason === "cancelled"
      ? "EVENTO CANCELADO"
      : unavailableReason === "deleted" ? "EVENTO NO DISPONIBLE"
      : unavailableReason === "unassigned" ? "Ya no estás asignado a este evento" : undefined;
    const message = unavailableReason === "cancelled"
      ? "Este evento fue cancelado"
      : unavailableReason === "deleted"
        ? "Este evento fue eliminado"
        : unavailableReason === "unassigned" || unavailableReason === "general"
          ? "La información de este evento ya no está disponible para su consulta"
          : "Información no disponible sin conexión";

    return (
      <div className="event-summary-backdrop" onClick={onClose}>
        <section
          className="event-summary-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="event-summary-title"
          onClick={(clickEvent) => clickEvent.stopPropagation()}
        >
          <header className="event-summary-header">
            <div className="event-summary-heading-icon" aria-hidden="true"><CalendarX2 size={22} /></div>
            <div className="event-summary-heading-copy">
              <h2 id="event-summary-title">Información no disponible</h2>
              {notice && <span className="event-summary-status">{notice}</span>}
            </div>
            <button type="button" className="event-summary-close" onClick={onClose} aria-label="Cerrar información"><X size={19} /></button>
          </header>
          <div className="event-summary-content">
            <section className="event-summary-section">
              <p>{message}</p>
            </section>
          </div>
          <footer className="event-summary-footer">
            <button type="button" onClick={onClose}>Cerrar</button>
          </footer>
        </section>
      </div>
    );
  }

  const [year, month, day] = event.date.split("-").map(Number);
  const dateLabel = year && month && day
    ? new Date(year, month - 1, day).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })
    : "Fecha no disponible";
  const formatTime = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString("es-MX", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };
  const startMinutes = event.startTime.split(":").map(Number);
  const endMinutes = event.endTime.split(":").map(Number);
  const endsNextDay = endMinutes[0] * 60 + endMinutes[1] < startMinutes[0] * 60 + startMinutes[1];
  const workers = event.assignedWorkers ?? [];
  const isUnassigned = event.status === "unassigned";
  const organizerName = event.createdBy?.name?.trim()
    || (isUnassigned ? "No disponible en esta notificación" : "No disponible");
  const reminderUnit = event.reminderUnit ?? "minutes";

  return (
    <div className="event-summary-backdrop" onClick={onClose}>
      <section
        className="event-summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-summary-title"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="event-summary-header">
          <div className="event-summary-heading-icon" aria-hidden="true"><CalendarDays size={22} /></div>
          <div className="event-summary-heading-copy">
            <span>Información del evento</span>
            <h2 id="event-summary-title">{event.title}</h2>
            {event.status === "cancelled" && <span className="event-summary-status">Evento cancelado</span>}
            {event.status === "unassigned" && <span className="event-summary-status">Ya no estás asignado a este evento</span>}
          </div>
          <button type="button" className="event-summary-close" onClick={onClose} aria-label="Cerrar resumen"><X size={19} /></button>
        </header>

        <div className="event-summary-content">
          {isOfflineSnapshot && (
            <p className="event-summary-offline-note" role="status">
              Datos guardados sin conexión. No se pueden verificar el acceso ni los cambios recientes.
            </p>
          )}
          <div className="event-summary-facts">
            <article className="event-summary-fact">
              <CalendarDays size={18} aria-hidden="true" />
              <div><span>Fecha</span><strong>{dateLabel}</strong></div>
            </article>
            <article className="event-summary-fact">
              <Clock3 size={18} aria-hidden="true" />
              <div>
                <span>Horario</span>
                <strong>{formatTime(event.startTime)} - {formatTime(event.endTime)}{endsNextDay ? " · día siguiente" : ""}</strong>
              </div>
            </article>
            {event.category && (
              <article className="event-summary-fact">
                <Tag size={18} aria-hidden="true" />
                <div><span>Categoría</span><strong>{event.category}</strong></div>
              </article>
            )}
          </div>

          <section className="event-summary-section">
            <h3><FileText size={16} aria-hidden="true" /> Descripción</h3>
            <p>{event.description?.trim() || (isUnassigned
              ? "Descripción no incluida en esta notificación."
              : "Sin descripción.")}</p>
          </section>

          <section className="event-summary-section">
            <h3><UsersRound size={16} aria-hidden="true" /> {event.status === "cancelled" ? "Participantes al momento de la cancelación" : "Participación"}</h3>
            <div className="event-summary-people">
              <span className="event-summary-person">
                <UserRound size={15} aria-hidden="true" />
                <span><small>Organiza</small><strong>{organizerName}</strong></span>
              </span>
              {!isUnassigned && workers.map((worker) => (
                <span className="event-summary-person" key={worker.id}>
                  <UserRound size={15} aria-hidden="true" />
                  <span>
                    <small>Participa</small>
                    <strong>{worker.name.trim() && worker.name !== "Trabajador" ? worker.name : "Nombre no disponible"}</strong>
                  </span>
                </span>
              ))}
              {isUnassigned
                ? <span className="event-summary-personal-label">Ya no participas en este evento</span>
                : workers.length === 0 && <span className="event-summary-personal-label">Evento personal</span>}
            </div>
          </section>

          {event.status !== "cancelled" && event.reminderEnabled && event.reminderValue && (
            <section className="event-summary-reminder">
              <BellRing size={17} aria-hidden="true" />
              <span>Anticipación configurada: {event.reminderValue} {reminderLabels[reminderUnit][event.reminderValue === 1 ? 0 : 1]}</span>
            </section>
          )}
        </div>

        <footer className="event-summary-footer">
          <button type="button" onClick={onClose}>Cerrar</button>
        </footer>
      </section>
    </div>
  );
}

export default EventSummaryDialog;