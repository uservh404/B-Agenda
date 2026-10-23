import { BellRing, CalendarDays, Clock3, FileText, Tag, UserRound, UsersRound, X } from "lucide-react";
import type { NotificationEventDetails } from "../auth/notifications";
import "./S-event-summary.css";

interface EventSummaryDialogProps {
  event: NotificationEventDetails;
  onClose: () => void;
}

const reminderLabels = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["día", "días"],
  weeks: ["semana", "semanas"],
} as const;

function EventSummaryDialog({ event, onClose }: EventSummaryDialogProps) {
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
            <span>Resumen del evento</span>
            <h2 id="event-summary-title">{event.title}</h2>
          </div>
          <button type="button" className="event-summary-close" onClick={onClose} aria-label="Cerrar resumen"><X size={19} /></button>
        </header>

        <div className="event-summary-content">
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
            <p>{event.description?.trim() || "Sin descripción."}</p>
          </section>

          <section className="event-summary-section">
            <h3><UsersRound size={16} aria-hidden="true" /> Participación</h3>
            <div className="event-summary-people">
              <span className="event-summary-person">
                <UserRound size={15} aria-hidden="true" />
                <span><small>Organiza</small><strong>{event.createdBy?.name || "No disponible"}</strong></span>
              </span>
              {workers.map((worker) => (
                <span className="event-summary-person" key={worker.id}>
                  <UserRound size={15} aria-hidden="true" />
                  <span><small>Participa</small><strong>{worker.name}</strong></span>
                </span>
              ))}
              {workers.length === 0 && <span className="event-summary-personal-label">Evento personal</span>}
            </div>
          </section>

          {event.reminderEnabled && event.reminderValue && (
            <section className="event-summary-reminder">
              <BellRing size={17} aria-hidden="true" />
              <span>Aviso {event.reminderValue} {reminderLabels[reminderUnit][event.reminderValue === 1 ? 0 : 1]} antes</span>
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