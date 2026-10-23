import "./S-principal.css";
import { useEffect, useState } from "react";
import { Eye, Trash2 } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import EventSummaryDialog from "../components/EventSummaryDialog";
import { readUsers } from "../auth/users";
import { getActiveUserId, getCurrentUserRole } from "../auth/permissions";
import { addNotification } from "../auth/notifications";

const eventsStorageKey = "biblioteca-events";

interface EventItem {
  id: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  reminderEnabled: boolean;
  reminderValue: number;
  reminderUnit: "minutes" | "hours" | "days" | "weeks";
  createdBy: { id: number; name: string };
  assignedWorkers: { id: number; name: string }[];
  category: string;
  date: string;
}

interface ScheduleConflict {
  id: string;
  personName: string;
  eventTitle: string;
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
}

type EventAudienceFilter = "all" | "collaborative" | "personal";

function readEvents(): EventItem[] {
  try {
    const storedEvents = window.localStorage.getItem(eventsStorageKey);
    if (!storedEvents) return [];
    const parsedEvents: unknown = JSON.parse(storedEvents);
    return Array.isArray(parsedEvents) ? parsedEvents as EventItem[] : [];
  } catch {
    return [];
  }
}

function timeToMinutes(time: string): number | null {
  const [hoursText, minutesText] = time.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function getEventInterval(date: string, startTime: string, endTime: string) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;

  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day, Math.floor(startMinutes / 60), startMinutes % 60);
  const end = new Date(year, month - 1, day, Math.floor(endMinutes / 60), endMinutes % 60);
  const endsNextDay = endMinutes < startMinutes;
  if (endsNextDay) end.setDate(end.getDate() + 1);

  return { start: start.getTime(), end: end.getTime(), endsNextDay };
}

function getEventEndDateKey(event: Pick<EventItem, "date" | "startTime" | "endTime">) {
  const startMinutes = timeToMinutes(event.startTime);
  const endMinutes = timeToMinutes(event.endTime);
  if (startMinutes === null || endMinutes === null || endMinutes >= startMinutes) return event.date;

  const [year, month, day] = event.date.split("-").map(Number);
  const endDate = new Date(year, month - 1, day + 1);
  return `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
}

const reminderUnitLabels = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["día", "días"],
  weeks: ["semana", "semanas"],
} as const;

function Principal() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [yearDropdownOpen, setYearDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [eventAudienceFilter, setEventAudienceFilter] = useState<EventAudienceFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [formError, setFormError] = useState("");
  const [scheduleConflicts, setScheduleConflicts] = useState<ScheduleConflict[]>([]);
  const [eventToView, setEventToView] = useState<EventItem | null>(null);
  const [events, setEvents] = useState<EventItem[]>(readEvents);
  const [eventIdSequence, setEventIdSequence] = useState(() =>
    events.reduce((highestId, event) => Math.max(highestId, Number(event.id) || 0), 0) + 1,
  );
  const [currentUserId] = useState(getActiveUserId);
  const [currentUserRole] = useState(getCurrentUserRole);
  const [registeredUsers, setRegisteredUsers] = useState(readUsers);
  const [formData, setFormData] = useState({
    title: "",
    startTime: "",
    endTime: "",
    reminderEnabled: false,
    reminderValue: 15,
    reminderUnit: "minutes" as EventItem["reminderUnit"],
    assignedWorkerIds: [] as number[],
    description: "",
    category: "",
  });
  const [eventToDelete, setEventToDelete] = useState<string | null>(null);
  const eventPendingDeletion = events.find((event) => event.id === eventToDelete);
  const currentRoleName = currentUserRole === "administrador" ? "Administrador" : "Empleado";
  const currentUser = registeredUsers.find((user) => user.id === currentUserId) ?? registeredUsers.find((user) => user.role === currentRoleName) ?? {
    id: currentUserRole === "administrador" ? 1 : 2,
    name: currentUserRole === "administrador" ? "María González" : "Carlos Rodríguez",
    role: currentRoleName,
    canAssignEvents: currentRoleName === "Administrador",
  };
  const canAssignEvents = currentUser.role === "Administrador" || currentUser.canAssignEvents;
  const assignableUsers = registeredUsers.filter((user) => user.id !== currentUser.id);

  useEffect(() => {
    const syncRegisteredUsers = () => setRegisteredUsers(readUsers());
    window.addEventListener("storage", syncRegisteredUsers);
    return () => window.removeEventListener("storage", syncRegisteredUsers);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(eventsStorageKey, JSON.stringify(events));
    window.dispatchEvent(new Event("biblioteca-events-updated"));
  }, [events]);

  useEffect(() => {
    const syncEvents = () => setEvents(readEvents());
    window.addEventListener("storage", syncEvents);
    return () => window.removeEventListener("storage", syncEvents);
  }, []);

  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const day = selectedDate.getDate();

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const leadingDays = firstDay === 0 ? 6 : firstDay - 1;

  const calendarCells = [
    ...Array.from({ length: leadingDays }, (_, index) => ({ key: `empty-${index}`, value: null })),
    ...Array.from({ length: daysInMonth }, (_, index) => ({ key: `day-${index + 1}`, value: index + 1 })),
  ];

  const formatDateKey = (date: Date) => {
    const yearValue = date.getFullYear();
    const monthValue = String(date.getMonth() + 1).padStart(2, "0");
    const dayValue = String(date.getDate()).padStart(2, "0");
    return `${yearValue}-${monthValue}-${dayValue}`;
  };

  const changeMonth = (value: number) => {
    setSelectedDate(new Date(year, month + value, 1));
  };

  const changeYear = (value: number) => {
    setSelectedDate(new Date(value, month, 1));
    setYearDropdownOpen(false);
  };

  const openModal = (dayNumber?: number) => {
    if (typeof dayNumber === "number") {
      setSelectedDate(new Date(year, month, dayNumber));
    }

    setEditingEventId(null);
    setFormData({
      title: "",
      startTime: "",
      endTime: "",
      reminderEnabled: false,
      reminderValue: 15,
      reminderUnit: "minutes",
      assignedWorkerIds: [],
      description: "",
      category: "",
    });
    setFormError("");
    setScheduleConflicts([]);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingEventId(null);
    setFormError("");
    setScheduleConflicts([]);
  };

  const handleSaveEvent = () => {
    setScheduleConflicts([]);

    if (!formData.title.trim()) {
      alert("Ingresa un título para el evento.");
      return;
    }

    if (!formData.startTime || !formData.endTime) {
      setFormError("Indica la hora de inicio y de finalización.");
      return;
    }

    const startTimeMinutes = timeToMinutes(formData.startTime);
    const endTimeMinutes = timeToMinutes(formData.endTime);
    if (startTimeMinutes === null || endTimeMinutes === null) {
      setFormError("Selecciona una hora de inicio y de finalización válidas.");
      return;
    }

    if (endTimeMinutes === startTimeMinutes) {
      setFormError("La hora de inicio y finalización no pueden ser iguales.");
      return;
    }

    const eventDate = formatDateKey(selectedDate);
    const existingEvent = events.find((event) => event.id === editingEventId);
    const scheduleChanged = !existingEvent ||
      existingEvent.date !== eventDate ||
      existingEvent.startTime !== formData.startTime ||
      existingEvent.endTime !== formData.endTime;
    const proposedInterval = getEventInterval(eventDate, formData.startTime, formData.endTime);
    if (!proposedInterval) {
      setFormError("Revisa las horas de inicio y finalización.");
      return;
    }

    if (scheduleChanged && proposedInterval.start <= new Date().getTime()) {
      setFormError("La hora de inicio ya pasó. Elige una fecha y hora futuras para agendar el evento.");
      return;
    }

    if (formData.reminderEnabled && formData.reminderValue < 1) {
      setFormError("La alerta debe configurarse con al menos una unidad.");
      return;
    }

    const assignedWorkers = canAssignEvents
      ? assignableUsers
          .filter((employee) => formData.assignedWorkerIds.includes(employee.id))
          .map(({ id, name }) => ({ id, name }))
      : existingEvent?.assignedWorkers ?? [];
    const participantNames = new Map<number, string>([
      [currentUser.id, currentUser.name],
      ...assignedWorkers.map((employee) => [employee.id, employee.name] as [number, string]),
    ]);
    const proposedParticipants = new Set(participantNames.keys());
    const conflicts = events.flatMap((existingEvent) => {
      const existingInterval = getEventInterval(existingEvent.date, existingEvent.startTime, existingEvent.endTime);
      if (
        existingEvent.id === editingEventId ||
        !existingInterval ||
        proposedInterval.start >= existingInterval.end ||
        existingInterval.start >= proposedInterval.end
      ) {
        return [];
      }

      const existingParticipants = [existingEvent.createdBy, ...existingEvent.assignedWorkers];
      return existingParticipants
        .filter((person) => proposedParticipants.has(person.id))
        .map((person) => ({
          id: `${existingEvent.id}-${person.id}`,
          personName: participantNames.get(person.id) ?? person.name,
          eventTitle: existingEvent.title,
          startTime: existingEvent.startTime,
          endTime: existingEvent.endTime,
          endsNextDay: existingInterval.endsNextDay,
        }));
    });

    if (conflicts.length > 0) {
      setFormError("");
      setScheduleConflicts(conflicts);
      return;
    }

    setFormError("");

    if (editingEventId) {
      const updatedEvent: EventItem = {
        ...existingEvent!,
        title: formData.title.trim(),
        startTime: formData.startTime,
        endTime: formData.endTime,
        reminderEnabled: formData.reminderEnabled,
        reminderValue: formData.reminderValue,
        reminderUnit: formData.reminderUnit,
        assignedWorkers,
        description: formData.description.trim(),
        category: formData.category,
        date: eventDate,
      };
      const oldWorkerIds = new Set(existingEvent?.assignedWorkers.map((worker) => worker.id) ?? []);
      const updatedWorkerIds = new Set(assignedWorkers.map((worker) => worker.id));
      const eventChanged = existingEvent && (
        existingEvent.title !== updatedEvent.title ||
        existingEvent.date !== updatedEvent.date ||
        existingEvent.startTime !== updatedEvent.startTime ||
        existingEvent.endTime !== updatedEvent.endTime ||
        existingEvent.description !== updatedEvent.description ||
        existingEvent.category !== updatedEvent.category ||
        existingEvent.reminderEnabled !== updatedEvent.reminderEnabled ||
        existingEvent.reminderValue !== updatedEvent.reminderValue ||
        existingEvent.reminderUnit !== updatedEvent.reminderUnit ||
        oldWorkerIds.size !== updatedWorkerIds.size ||
        [...oldWorkerIds].some((workerId) => !updatedWorkerIds.has(workerId))
      );
      const notificationEvent = {
        id: updatedEvent.id,
        title: updatedEvent.title,
        date: updatedEvent.date,
        startTime: updatedEvent.startTime,
        endTime: updatedEvent.endTime,
        description: updatedEvent.description,
        category: updatedEvent.category,
        createdBy: updatedEvent.createdBy,
        assignedWorkers: updatedEvent.assignedWorkers,
        reminderEnabled: updatedEvent.reminderEnabled,
        reminderValue: updatedEvent.reminderValue,
        reminderUnit: updatedEvent.reminderUnit,
      };

      assignedWorkers.forEach((worker) => {
        if (!oldWorkerIds.has(worker.id)) {
          addNotification({
            recipientId: worker.id,
            kind: "event_assigned",
            title: "Te asignaron a un evento",
            message: `${currentUser.name} te asignó al evento “${updatedEvent.title}”.`,
            event: notificationEvent,
          });
        } else if (eventChanged) {
          addNotification({
            recipientId: worker.id,
            kind: "event_updated",
            title: "Evento actualizado",
            message: `Se modificaron los detalles de “${updatedEvent.title}”.`,
            event: notificationEvent,
          });
        }
      });

      existingEvent?.assignedWorkers.forEach((worker) => {
        if (!updatedWorkerIds.has(worker.id)) {
          addNotification({
            recipientId: worker.id,
            kind: "event_unassigned",
            title: "Ya no estás asignado al evento",
            message: `${currentUser.name} te retiró del evento “${existingEvent.title}”.`,
            event: { ...notificationEvent, assignedWorkers: existingEvent.assignedWorkers },
          });
        }
      });

      setEvents((prev) =>
        prev.map((event) =>
          event.id === editingEventId
            ? updatedEvent
            : event,
        ),
      );
      closeModal();
      return;
    }

    const newEvent: EventItem = {
      id: String(eventIdSequence),
      title: formData.title.trim(),
      startTime: formData.startTime,
      endTime: formData.endTime,
      reminderEnabled: formData.reminderEnabled,
      reminderValue: formData.reminderValue,
      reminderUnit: formData.reminderUnit,
      createdBy: { id: currentUser.id, name: currentUser.name },
      assignedWorkers,
      description: formData.description.trim(),
      category: formData.category,
      date: eventDate,
    };

    assignedWorkers.forEach((worker) => addNotification({
      recipientId: worker.id,
      kind: "event_assigned",
      title: "Te asignaron a un evento",
      message: `${currentUser.name} te asignó al evento “${newEvent.title}”.`,
      event: {
        id: newEvent.id,
        title: newEvent.title,
        date: newEvent.date,
        startTime: newEvent.startTime,
        endTime: newEvent.endTime,
        description: newEvent.description,
        category: newEvent.category,
        createdBy: newEvent.createdBy,
        assignedWorkers: newEvent.assignedWorkers,
        reminderEnabled: newEvent.reminderEnabled,
        reminderValue: newEvent.reminderValue,
        reminderUnit: newEvent.reminderUnit,
      },
    }));

    setEventIdSequence((currentSequence) => currentSequence + 1);
    setEvents((prev) => [...prev, newEvent]);
    closeModal();
  };

  const yearOptions = Array.from({ length: 100 }, (_, index) => 2000 + index);

  const getEventDateTime = (event: EventItem) => {
    const [eventYear, eventMonth, eventDay] = event.date.split("-").map(Number);
    const [hours = 23, minutes = 59] = event.startTime.split(":").map(Number);
    return new Date(eventYear, eventMonth - 1, eventDay, hours, minutes).getTime();
  };

  const eventsForCurrentUser = events.filter((event) =>
    event.createdBy.id === currentUser.id || event.assignedWorkers.some((employee) => employee.id === currentUser.id),
  );
  const sortedEvents = [...eventsForCurrentUser].sort((a, b) => getEventDateTime(a) - getEventDateTime(b));
  const eventsByAudience = sortedEvents.filter((event) => {
    if (eventAudienceFilter === "collaborative") return event.assignedWorkers.length > 0;
    if (eventAudienceFilter === "personal") return event.createdBy.id === currentUser.id && event.assignedWorkers.length === 0;
    return true;
  });
  const filteredEvents = [...eventsByAudience]
    .filter((event) => {
      if (!searchText.trim()) return true;
      const query = searchText.toLowerCase();
      return (
        event.title.toLowerCase().includes(query) ||
        event.category.toLowerCase().includes(query) ||
        event.description.toLowerCase().includes(query)
      );
    });

  const eventCounts = {
    all: sortedEvents.length,
    collaborative: sortedEvents.filter((event) => event.assignedWorkers.length > 0).length,
    personal: sortedEvents.filter((event) => event.createdBy.id === currentUser.id && event.assignedWorkers.length === 0).length,
  };

  const formatEventDate = (eventDate: string) => {
    const [year, month, day] = eventDate.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("es-ES", {
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

  const eventEndsNextDay = (event: Pick<EventItem, "startTime" | "endTime">) => {
    const startMinutes = timeToMinutes(event.startTime);
    const endMinutes = timeToMinutes(event.endTime);
    return startMinutes !== null && endMinutes !== null && endMinutes < startMinutes;
  };

  const getEventCountForDay = (dayNumber: number) => {
    const currentDateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    return eventsByAudience.filter((event) => event.date === currentDateKey || getEventEndDateKey(event) === currentDateKey).length;
  };

  const hasSharedEventOnDay = (dayNumber: number) => {
    const currentDateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    return eventsByAudience.some((event) => (event.date === currentDateKey || getEventEndDateKey(event) === currentDateKey) && event.assignedWorkers.length > 0);
  };

  const getPreviewText = (text: string) => {
    if (!text) return "Sin descripción.";
    const words = text.trim().split(/\s+/);
    if (words.length <= 12) return text;
    return `${words.slice(0, 12).join(" ")}...`;
  };

  const hasEventOnDay = (dayNumber: number) => {
    const currentDateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    return eventsByAudience.some((event) => event.date === currentDateKey || getEventEndDateKey(event) === currentDateKey);
  };

  const handleEditEvent = (event: EventItem) => {
    setEditingEventId(event.id);
    setFormData({
      title: event.title,
      startTime: event.startTime,
      endTime: event.endTime,
      reminderEnabled: event.reminderEnabled,
      reminderValue: event.reminderValue,
      reminderUnit: event.reminderUnit,
      assignedWorkerIds: event.assignedWorkers.map((employee) => employee.id),
      description: event.description,
      category: event.category,
    });
    setSelectedDate(new Date(Number(event.date.split("-")[0]), Number(event.date.split("-")[1]) - 1, Number(event.date.split("-")[2])));
    setModalOpen(true);
  };

  const handleDeleteEvent = (eventId: string) => {
    setEvents((prev) => prev.filter((event) => event.id !== eventId));
    setEventToDelete(null);
  };

  return (
    <div className="dashboard">
      <Sidebar />

      <main className="content">
        <div className="content-header">
          <h1>Zona joven</h1>
          <p>Gestiona tu biblioteca, eventos, anuncios y recursos de manera eficiente.</p>
        </div>

        <div className="cards-grid">
          <div className="welcome-card">
            <div className="welcome-card-header">
              <h3>Bienvenido</h3>
              <div className="event-filter-wrapper">
                <button
                  type="button"
                  className="filter-trigger"
                  onClick={() => setFilterMenuOpen((prev) => !prev)}
                  aria-label="Abrir filtros de eventos"
                >
                  ☰
                </button>

                {filterMenuOpen && (
                  <div className="filter-menu">
                    {[
                      { value: "all", label: "Toda la agenda" },
                      { value: "collaborative", label: "Agenda colaborativa" },
                      { value: "personal", label: "Mi agenda personal" },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`filter-menu-item ${eventAudienceFilter === option.value ? "selected" : ""}`}
                        onClick={() => {
                          setEventAudienceFilter(option.value as EventAudienceFilter);
                          setFilterMenuOpen(false);
                        }}
                      >
                        <span>{option.label}</span>
                        <span className="filter-count">{eventCounts[option.value as keyof typeof eventCounts]}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="event-search-box">
              <span className="search-icon">⌕</span>
              <input
                type="text"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Buscar título o categoría"
                aria-label="Buscar evento"
              />
            </div>

            <p className="welcome-subtitle">Aquí aparecerán tus eventos programados.</p>

            {filteredEvents.length === 0 ? (
              <div className="empty-events">
                <p>No hay eventos programados con este filtro.</p>
              </div>
            ) : (
              <div className="event-list">
                {filteredEvents.map((event) => (
                  <div className={`event-card event-card-${event.assignedWorkers.length > 0 ? "shared" : "personal"}`} key={event.id}>
                    <div className="event-card-header">
                      <div>
                        <p className="event-date">{formatEventDate(event.date)}</p>
                        <h4>{event.title}</h4>
                      </div>
                      {event.category && <span className="event-category">{event.category}</span>}
                    </div>

                    <p className="event-time">
                      ⏰ {formatEventTime(event.startTime)} - {formatEventTime(event.endTime)}
                      {eventEndsNextDay(event) && <span className="event-next-day-label"> · día siguiente</span>}
                    </p>
                    {event.reminderEnabled && (
                      <span className="event-reminder-pill">
                        Aviso {event.reminderValue} {reminderUnitLabels[event.reminderUnit][event.reminderValue === 1 ? 0 : 1]} antes
                      </span>
                    )}

                    <div className="event-assignees" aria-label="Organizador y trabajadores asignados">
                      <span>Organiza</span>
                      <span className="event-assignee-chip">{event.createdBy.name}</span>
                      {event.assignedWorkers.length > 0 && (
                        <>
                          <span>Con</span>
                          {event.assignedWorkers.map((employee) => (
                            <span className="event-assignee-chip" key={employee.id}>{employee.name}</span>
                          ))}
                        </>
                      )}
                    </div>

                    {event.description && (
                      <p className="event-description">{getPreviewText(event.description)}</p>
                    )}

                    <div className="event-card-footer">
                      <span className={`event-scope-pill scope-${event.assignedWorkers.length > 0 ? "shared" : "personal"}`}>
                        {event.assignedWorkers.length > 0 ? "Compartido" : "Personal"}
                      </span>

                      <div className="event-actions">
                        <button className="action-btn summary-btn" type="button" onClick={() => setEventToView(event)} aria-label={`Ver resumen de ${event.title}`} title="Ver resumen">
                          <Eye size={16} aria-hidden="true" />
                        </button>
                        {event.createdBy.id === currentUser.id && (
                          <>
                            <button className="action-btn edit-btn" type="button" onClick={() => handleEditEvent(event)} aria-label={`Editar ${event.title}`}>
                              ✏️
                            </button>
                            <button className="action-btn delete-btn" type="button" onClick={() => setEventToDelete(event.id)} aria-label={`Eliminar ${event.title}`}>
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="calendar-card">
            <div className="calendar-header">
              <h3>Calendario</h3>
              <div className="calendar-controls">
                <button className="calendar-nav" onClick={() => changeMonth(-1)}>
                  ←
                </button>
                <select
                  className="calendar-select"
                  value={month}
                  onChange={(e) => setSelectedDate(new Date(year, Number(e.target.value), 1))}
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <option key={index} value={index}>
                      {new Date(2024, index).toLocaleDateString("es-ES", { month: "long" })}
                    </option>
                  ))}
                </select>
                <div className="year-picker">
                  <button
                    type="button"
                    className="calendar-select year-trigger"
                    onClick={() => setYearDropdownOpen(!yearDropdownOpen)}
                  >
                    {year}
                  </button>

                  {yearDropdownOpen && (
                    <div className="year-dropdown">
                      <div className="year-dropdown-list">
                        {yearOptions.map((yearOption) => (
                          <button
                            key={yearOption}
                            type="button"
                            className={`year-option ${yearOption === year ? "selected" : ""}`}
                            onClick={() => changeYear(yearOption)}
                          >
                            {yearOption}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button className="calendar-nav" onClick={() => changeMonth(1)}>
                  →
                </button>
              </div>
            </div>

            <div className="calendar-grid">
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((day) => (
                <div key={day} className="day-name">
                  {day}
                </div>
              ))}

              {calendarCells.map((cell) => {
                const eventCount = cell.value === null ? 0 : getEventCountForDay(cell.value as number);
                const hasEvents = cell.value !== null && hasEventOnDay(cell.value as number);
                const hasSharedEvents = cell.value !== null && hasSharedEventOnDay(cell.value as number);

                return cell.value === null ? (
                  <div key={cell.key} className="calendar-day empty" />
                ) : (
                  <div
                    key={cell.key}
                    className={`calendar-day ${cell.value === day ? "active" : ""} ${
                      isCurrentMonth && cell.value === todayDate ? "today" : ""
                    } ${hasEvents ? (hasSharedEvents ? "has-shared-event" : "has-personal-event") : ""}`}
                    onClick={() => {
                      setSelectedDate(new Date(year, month, cell.value as number));
                      openModal(cell.value as number);
                    }}
                  >
                    <span>{cell.value}</span>
                    {hasEvents && (
                      <span className={`event-badge ${hasSharedEvents ? "shared" : "personal"} ${eventCount > 1 ? "multi" : ""}`} aria-label={`Tiene ${eventCount} evento${eventCount > 1 ? "s" : ""}`}>
                        {eventCount > 1 ? eventCount : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="appointments">
              <button
                className="add-event-button"
                type="button"
                aria-label="Agregar nuevo evento"
                onClick={() => openModal()}
              >
                <span className="add-event-icon">＋</span>
              </button>
              <p className="add-event-text">Agregar nuevo evento</p>
            </div>
          </div>
        </div>
      </main>

      {modalOpen && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>Nuevo evento</h3>
              <button className="modal-close" type="button" onClick={closeModal}>
                ×
              </button>
            </div>

            <form className="modal-body" autoComplete="off" onSubmit={(event) => { event.preventDefault(); handleSaveEvent(); }}>
              <div className="form-group">
                <label htmlFor="event-title">Título del evento</label>
                <input
                  id="event-title"
                  type="text"
                  autoComplete="off"
                  value={formData.title}
                  placeholder="Ej. reunión, evento, paciente"
                  onChange={(event) => setFormData({ ...formData, title: event.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Horario del evento</label>
                <div className="time-range-control">
                  <div className="time-input-card">
                    <label htmlFor="event-start-time">Inicio</label>
                    <input
                      id="event-start-time"
                      type="time"
                      autoComplete="off"
                      required
                      value={formData.startTime}
                      onChange={(event) => {
                        setFormData({ ...formData, startTime: event.target.value });
                        setFormError("");
                        setScheduleConflicts([]);
                      }}
                    />
                  </div>
                  <span className="time-range-divider" aria-hidden="true">hasta</span>
                  <div className="time-input-card">
                    <label htmlFor="event-end-time">Finaliza</label>
                    <input
                      id="event-end-time"
                      type="time"
                      autoComplete="off"
                      required
                      value={formData.endTime}
                      onChange={(event) => {
                        setFormData({ ...formData, endTime: event.target.value });
                        setFormError("");
                        setScheduleConflicts([]);
                      }}
                    />
                  </div>
                </div>
                <p className="time-range-hint">Si la hora final es anterior a la inicial, se considera que termina al día siguiente.</p>
              </div>

              {canAssignEvents ? (
              <section className="assignees-section" aria-labelledby="assignees-title">
                <div className="assignees-heading">
                  <div>
                    <h4 id="assignees-title">Asignar trabajadores</h4>
                    <p>Selecciona quiénes participarán</p>
                  </div>
                  <span className="assignees-count">{formData.assignedWorkerIds.length}</span>
                </div>
                {assignableUsers.length === 0 ? (
                  <p className="assignees-empty">No hay empleados registrados para asignar.</p>
                ) : (
                  <div className="assignees-list" role="group" aria-label="Trabajadores disponibles">
                    {assignableUsers.map((assignableUser) => {
                      const isAssigned = formData.assignedWorkerIds.includes(assignableUser.id);
                      return (
                        <label className={`assignee-option ${isAssigned ? "selected" : ""}`} key={assignableUser.id}>
                          <input
                            type="checkbox"
                            checked={isAssigned}
                            onChange={() => {
                              setFormData((current) => ({
                                ...current,
                                assignedWorkerIds: isAssigned
                                  ? current.assignedWorkerIds.filter((id) => id !== assignableUser.id)
                                  : [...current.assignedWorkerIds, assignableUser.id],
                              }));
                              setScheduleConflicts([]);
                            }}
                          />
                          <span className="assignee-avatar" aria-hidden="true">{assignableUser.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span>
                          <span className="assignee-information">
                            <strong>{assignableUser.name}</strong>
                            <small>{assignableUser.email}</small>
                          </span>
                          <span className="assignee-role">{assignableUser.role}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
              ) : (
                <div className="personal-event-note">
                  <span className="personal-event-note-dot" aria-hidden="true" />
                  <p>Este evento será personal y solo aparecerá en tu agenda.</p>
                </div>
              )}

              <section className="reminder-group" aria-labelledby="reminder-title">
                <div className="reminder-heading">
                  <div>
                    <h4 id="reminder-title">Alerta</h4>
                    <p>Recibir un aviso antes del evento</p>
                  </div>
                  <button
                    className={`reminder-switch ${formData.reminderEnabled ? "enabled" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={formData.reminderEnabled}
                    aria-label="Activar alerta para este evento"
                    onClick={() => setFormData({ ...formData, reminderEnabled: !formData.reminderEnabled })}
                  >
                    <span />
                  </button>
                </div>
                <div className={`reminder-controls ${formData.reminderEnabled ? "" : "disabled"}`}>
                  <label htmlFor="reminder-value">Avisarme</label>
                  <div className="reminder-input-row">
                    <input
                      id="reminder-value"
                      type="number"
                      min="1"
                      max="999"
                      value={formData.reminderValue}
                      disabled={!formData.reminderEnabled}
                      onChange={(event) => setFormData({ ...formData, reminderValue: Number(event.target.value) })}
                    />
                    <select
                      aria-label="Unidad de tiempo de la alerta"
                      value={formData.reminderUnit}
                      disabled={!formData.reminderEnabled}
                      onChange={(event) => setFormData({ ...formData, reminderUnit: event.target.value as EventItem["reminderUnit"] })}
                    >
                      <option value="minutes">minutos antes</option>
                      <option value="hours">horas antes</option>
                      <option value="days">días antes</option>
                      <option value="weeks">semanas antes</option>
                    </select>
                  </div>
                </div>
              </section>

              {formError && <p className="event-form-error" role="alert">{formError}</p>}

              {scheduleConflicts.length > 0 && (
                <section className="schedule-conflict-alert" role="alert" aria-labelledby="schedule-conflict-title">
                  <div className="schedule-conflict-heading">
                    <span className="schedule-conflict-icon" aria-hidden="true">!</span>
                    <div>
                      <h4 id="schedule-conflict-title">No se puede asignar este horario</h4>
                      <p>Estas personas ya tienen un evento que coincide con este horario:</p>
                    </div>
                  </div>
                  <ul className="schedule-conflict-list">
                    {scheduleConflicts.map((conflict) => (
                      <li key={conflict.id}>
                        <div>
                          <strong>{conflict.personName}</strong>
                          <span>{conflict.eventTitle}</span>
                        </div>
                        <time>
                          {formatEventTime(conflict.startTime)} - {formatEventTime(conflict.endTime)}
                          {conflict.endsNextDay && <span> · día siguiente</span>}
                        </time>
                      </li>
                    ))}
                  </ul>
                  <p className="schedule-conflict-hint">Cambia el horario o la asignación para poder guardar.</p>
                </section>
              )}

              <div className="form-group">
                <label htmlFor="event-category">Categoría</label>
                <input
                  id="event-category"
                  type="text"
                  autoComplete="off"
                  value={formData.category}
                  placeholder="Ej. paciente, atención, reunion, evento"
                  onChange={(event) => setFormData({ ...formData, category: event.target.value })}
                />
              </div>

              <div className="form-group">
                <label htmlFor="event-description">Descripción</label>
                <textarea
                  id="event-description"
                  rows={4}
                  autoComplete="off"
                  value={formData.description}
                  placeholder="Detalles del evento..."
                  onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                />
              </div>
              <div className="modal-footer">
                <button className="btn-cancel" type="button" onClick={closeModal}>
                  Cancelar
                </button>
                <button className="btn-save" type="submit">
                  Guardar evento
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {eventPendingDeletion && <ConfirmDialog title="Eliminar evento" message={`¿Deseas eliminar “${eventPendingDeletion.title}”? Esta acción no se puede deshacer.`} onCancel={() => setEventToDelete(null)} onConfirm={() => handleDeleteEvent(eventPendingDeletion.id)} />}
      {eventToView && <EventSummaryDialog event={eventToView} onClose={() => setEventToView(null)} />}
    </div>
  );
}

export default Principal;