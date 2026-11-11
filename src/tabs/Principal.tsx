import "./S-principal.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Pencil, Trash2 } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import EventSummaryDialog from "../components/EventSummaryDialog";
import { useAuth } from "../auth/useAuth";
import { hasAdministrativePermission } from "../auth/auth-context";
import {
  cancelCalendarEvent,
  getCalendarOperationMessage,
  listAssignableWorkers,
  listCalendarEvents,
  removeCalendarChangesSubscription,
  saveCalendarEvent,
  subscribeToCalendarChanges,
} from "../services/calendar";
import type { AssignableWorker, CalendarEvent, ReminderUnit } from "../types/calendar";

type EventAudienceFilter = "all" | "collaborative" | "personal";

const CALENDAR_LOAD_TIMEOUT_MS = 20000;

function withCalendarLoadTimeout<T>(request: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("calendar_load_timeout")),
      CALENDAR_LOAD_TIMEOUT_MS,
    );
  });

  return Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId));
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

function getEventEndDateKey(event: Pick<CalendarEvent, "date" | "startTime" | "endTime">) {
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
  const { status: authStatus, profile, error: authError } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [yearDropdownOpen, setYearDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [eventAudienceFilter, setEventAudienceFilter] = useState<EventAudienceFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [formError, setFormError] = useState("");
  const [eventToView, setEventToView] = useState<CalendarEvent | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableWorker[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadWarning, setLoadWarning] = useState("");
  const [realtimeWarning, setRealtimeWarning] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingWorkers, setIsLoadingWorkers] = useState(false);
  const [workerLoadError, setWorkerLoadError] = useState("");
  const [pendingSaveConflict, setPendingSaveConflict] = useState<{ eventId: string; operationId: string } | null>(null);
  const [pendingCancelConflict, setPendingCancelConflict] = useState<{ eventId: string; operationId: string } | null>(null);
  const [draftEventId, setDraftEventId] = useState<string | null>(null);
  const [pendingSaveRequest, setPendingSaveRequest] = useState<{ fingerprint: string; operationId: string } | null>(null);
  const [pendingCancelRequest, setPendingCancelRequest] = useState<{ fingerprint: string; operationId: string } | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    startTime: "",
    endTime: "",
    reminderEnabled: false,
    reminderValue: 15,
    reminderUnit: "minutes" as ReminderUnit,
    assignedWorkerIds: [] as string[],
    description: "",
    category: "",
  });
  const [eventToDelete, setEventToDelete] = useState<string | null>(null);
  const eventLoadGeneration = useRef(0);
  const eventPendingDeletion = events.find((event) => event.id === eventToDelete);
  const currentUserId = profile?.id ?? "";
  const canAssignEvents = authStatus === "authenticated"
    && hasAdministrativePermission(profile, "can_assign_events");

  const reloadEvents = useCallback(async (showLoading = true) => {
    const requestGeneration = ++eventLoadGeneration.current;
    if (!profile?.id) {
      setEvents([]);
      setIsLoadingEvents(false);
      return false;
    }

    if (showLoading) setIsLoadingEvents(true);
    setLoadError("");
    setLoadWarning("");
    try {
      const result = await withCalendarLoadTimeout(listCalendarEvents());
      if (requestGeneration !== eventLoadGeneration.current) return false;
      setEvents(result.events);
      if (result.profileNamesUnavailable) {
        setLoadWarning("No fue posible cargar el nombre de todos los organizadores o participantes. Actualiza la agenda o inténtalo más tarde.");
      }
      return true;
    } catch {
      if (requestGeneration === eventLoadGeneration.current) {
        setLoadError("No se pudo cargar la agenda. Comprueba tu conexión e inténtalo nuevamente.");
      }
      return false;
    } finally {
      if (requestGeneration === eventLoadGeneration.current) {
        setIsLoadingEvents(false);
      }
    }
  }, [profile?.id]);

  useEffect(() => {
    if (authStatus === "authenticated" && profile) {
      let active = true;
      let hasSubscribed = false;
      queueMicrotask(() => {
        if (active) void reloadEvents();
      });
      const channel = subscribeToCalendarChanges(
        profile.id,
        () => {
          if (active) void reloadEvents(false);
        },
        (status) => {
          if (!active) return;
          if (status === "SUBSCRIBED") {
            setRealtimeWarning("");
            hasSubscribed = true;
            void reloadEvents(false);
            return;
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || (status === "CLOSED" && hasSubscribed)) {
            setRealtimeWarning("La actualización automática de la agenda no está disponible. Actualiza la agenda manualmente.");
          }
        },
      );
      return () => {
        active = false;
        eventLoadGeneration.current += 1;
        void removeCalendarChangesSubscription(channel);
      };
    }

    eventLoadGeneration.current += 1;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setEvents([]);
      setIsLoadingEvents(false);
      setLoadError("");
      setLoadWarning("");
      setRealtimeWarning("");
    });
    return () => {
      active = false;
      eventLoadGeneration.current += 1;
    };
  }, [authStatus, profile, reloadEvents]);

  useEffect(() => {
    if (!modalOpen || !canAssignEvents || !profile) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setIsLoadingWorkers(true);
      setWorkerLoadError("");
      void listAssignableWorkers(profile.id).then((workers) => {
        if (active) setAssignableUsers(workers);
      }).catch(() => {
        if (active) {
          setAssignableUsers([]);
          setWorkerLoadError("No se pudo consultar la lista de trabajadores autorizada.");
        }
      }).finally(() => {
        if (active) setIsLoadingWorkers(false);
      });
    });
    return () => {
      active = false;
    };
  }, [modalOpen, canAssignEvents, profile]);

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
    setDraftEventId((current) => current ?? crypto.randomUUID());
    if (canAssignEvents) {
      setAssignableUsers([]);
      setIsLoadingWorkers(true);
      setWorkerLoadError("");
    }
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
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingEventId(null);
    setFormError("");
    setIsLoadingWorkers(false);
  };

  const handleSaveEvent = async () => {
    if (!profile || isSaving) return;
    if (!formData.title.trim()) {
      setFormError("Ingresa un título para el evento.");
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
    const proposedStart = new Date(`${eventDate}T${formData.startTime}:00`);
    if (scheduleChanged && proposedStart.getTime() <= Date.now()) {
      setFormError("La hora de inicio ya pasó. Elige una fecha y hora futuras para agendar el evento.");
      return;
    }

    if (formData.reminderEnabled && (!Number.isInteger(formData.reminderValue) || formData.reminderValue < 1)) {
      setFormError("La alerta debe configurarse con al menos una unidad.");
      return;
    }

    const existingParticipantIds = existingEvent?.assignedWorkers.map((worker) => worker.id) ?? [];
    const participantIdsChanged = existingParticipantIds.length !== formData.assignedWorkerIds.length
      || existingParticipantIds.some((id) => !formData.assignedWorkerIds.includes(id));
    if (canAssignEvents && participantIdsChanged && workerLoadError) {
      setFormError("No se pudo verificar la lista de trabajadores. Inténtalo nuevamente.");
      return;
    }

    setFormError("");
    setIsSaving(true);
    const eventId = existingEvent?.id ?? draftEventId ?? crypto.randomUUID();
    const resolvesOperationId = pendingSaveConflict?.eventId === eventId
      ? pendingSaveConflict.operationId
      : null;
    const request = {
      eventId,
      expectedVersion: existingEvent?.version ?? 0,
      title: formData.title.trim(),
      description: formData.description.trim(),
      category: formData.category,
      date: eventDate,
      startTime: formData.startTime,
      endTime: formData.endTime,
      participantIds: canAssignEvents
        ? (existingEvent && !participantIdsChanged ? null : formData.assignedWorkerIds)
        : null,
      reminderEnabled: formData.reminderEnabled,
      reminderValue: formData.reminderEnabled ? formData.reminderValue : null,
      reminderUnit: formData.reminderEnabled ? formData.reminderUnit : null,
      resolvesOperationId,
    };
    const fingerprint = JSON.stringify(request);
    const operationId = pendingSaveRequest?.fingerprint === fingerprint
      ? pendingSaveRequest.operationId
      : crypto.randomUUID();
    setDraftEventId(eventId);
    setPendingSaveRequest({ fingerprint, operationId });
    try {
      const result = await saveCalendarEvent({
        operationId,
        ...request,
      });

      if (result.status !== "confirmed") {
        if (result.status === "conflict") {
          setPendingSaveConflict({ eventId, operationId });
          if (result.code === "version_conflict") {
            await reloadEvents();
            setFormError("El evento cambió en otra sesión. Se actualizó la agenda; revisa los datos antes de guardar nuevamente.");
            return;
          }
        }
        setFormError(getCalendarOperationMessage(result));
        return;
      }

      setPendingSaveRequest(null);
      setDraftEventId(null);
      setPendingSaveConflict(null);
      closeModal();
      await reloadEvents();
    } catch {
      setFormError("No se pudo confirmar el cambio. Reintenta con los mismos datos para comprobar si se guardó.");
    } finally {
      setIsSaving(false);
    }
  };

  const yearOptions = Array.from({ length: 100 }, (_, index) => 2000 + index);

  const getEventDateTime = (event: CalendarEvent) => {
    const [eventYear, eventMonth, eventDay] = event.date.split("-").map(Number);
    const [hours = 23, minutes = 59] = event.startTime.split(":").map(Number);
    return new Date(eventYear, eventMonth - 1, eventDay, hours, minutes).getTime();
  };

  const eventsForCurrentUser = events.filter((event) =>
    event.createdBy.id === currentUserId || event.assignedWorkers.some((employee) => employee.id === currentUserId),
  );
  const sortedEvents = [...eventsForCurrentUser].sort((a, b) => getEventDateTime(a) - getEventDateTime(b));
  const eventsByAudience = sortedEvents.filter((event) => {
    if (eventAudienceFilter === "collaborative") return event.assignedWorkers.length > 0;
    if (eventAudienceFilter === "personal") return event.createdBy.id === currentUserId && event.assignedWorkers.length === 0;
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
    personal: sortedEvents.filter((event) => event.createdBy.id === currentUserId && event.assignedWorkers.length === 0).length,
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

  const eventEndsNextDay = (event: Pick<CalendarEvent, "startTime" | "endTime">) => {
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

  const handleEditEvent = (event: CalendarEvent) => {
    setEditingEventId(event.id);
    if (canAssignEvents) {
      setAssignableUsers([]);
      setIsLoadingWorkers(true);
      setWorkerLoadError("");
    }
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

  const handleDeleteEvent = async (event: CalendarEvent) => {
    if (isSaving) return;
    setIsSaving(true);
    setLoadError("");
    try {
      const request = {
        eventId: event.id,
        expectedVersion: event.version,
        resolvesOperationId: pendingCancelConflict?.eventId === event.id
          ? pendingCancelConflict.operationId
          : null,
      };
      const fingerprint = JSON.stringify(request);
      const operationId = pendingCancelRequest?.fingerprint === fingerprint
        ? pendingCancelRequest.operationId
        : crypto.randomUUID();
      setPendingCancelRequest({ fingerprint, operationId });
      const result = await cancelCalendarEvent(
        operationId,
        request.eventId,
        request.expectedVersion,
        request.resolvesOperationId,
      );
      if (result.status !== "confirmed") {
        if (result.status === "conflict") {
          setPendingCancelConflict({ eventId: event.id, operationId });
          if (result.code === "version_conflict") {
            await reloadEvents();
            setLoadError(getCalendarOperationMessage(result));
          } else {
            setLoadError(getCalendarOperationMessage(result));
          }
        }
        setPendingCancelRequest({ fingerprint, operationId });
        return;
      }
      setPendingCancelRequest(null);
      setPendingCancelConflict(null);
      setEventToDelete(null);
      await reloadEvents();
    } catch {
      setLoadError("No se pudo cancelar el evento. Comprueba tu conexión e inténtalo nuevamente.");
    } finally {
      setIsSaving(false);
    }
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
            {loadError && <p className="event-form-error" role="alert">{loadError}</p>}
            {loadWarning && <p className="event-form-error" role="alert">{loadWarning}</p>}
            {realtimeWarning && <p className="event-form-error" role="status">{realtimeWarning}</p>}

            {isLoadingEvents ? (
              <div className="empty-events"><p>Cargando agenda...</p></div>
            ) : loadError && events.length === 0 ? (
              <div className="empty-events"><p>No se pudo mostrar la agenda.</p></div>
            ) : filteredEvents.length === 0 ? (
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
                        Anticipación: {event.reminderValue} {reminderUnitLabels[event.reminderUnit][event.reminderValue === 1 ? 0 : 1]}
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
                        {event.createdBy.id === currentUserId && (
                          <>
                            <button className="action-btn edit-btn" type="button" onClick={() => handleEditEvent(event)} aria-label={`Editar evento ${event.title}`} title="Editar evento">
                              <Pencil size={16} aria-hidden="true" />
                            </button>
                            <button className="action-btn delete-btn" type="button" disabled={isSaving} onClick={() => setEventToDelete(event.id)} aria-label={`Eliminar ${event.title}`}>
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
              <h3>{editingEventId ? "Editar evento" : "Nuevo evento"}</h3>
              <button className="modal-close" type="button" onClick={closeModal}>
                ×
              </button>
            </div>

            <form className="modal-body" autoComplete="off" onSubmit={(event) => { event.preventDefault(); handleSaveEvent(); }}>
              {editingEventId && (
                <div className="form-group">
                  <label htmlFor="event-date">Fecha del evento</label>
                  <input
                    id="event-date"
                    type="date"
                    value={formatDateKey(selectedDate)}
                    onChange={(event) => {
                      const [dateYear, dateMonth, dateDay] = event.target.value.split("-").map(Number);
                      if (dateYear && dateMonth && dateDay) {
                        setSelectedDate(new Date(dateYear, dateMonth - 1, dateDay));
                      }
                      setFormError("");
                    }}
                  />
                </div>
              )}

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
                {isLoadingWorkers ? (
                  <p className="assignees-empty">Cargando trabajadores...</p>
                ) : workerLoadError ? (
                  <p className="assignees-empty" role="alert">{workerLoadError}</p>
                ) : assignableUsers.length === 0 ? (
                  <p className="assignees-empty">No hay usuarios registrados para asignar.</p>
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
                            }}
                          />
                          <span className="assignee-avatar" aria-hidden="true">{assignableUser.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span>
                          <span className="assignee-information">
                            <strong>{assignableUser.name}</strong>
                          </span>
                          <span className="assignee-role">
                            {assignableUser.role === "administrador" ? "Administrador" : "Empleado"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
              ) : authStatus === "authenticated" && profile ? (
                <div className="personal-event-note">
                  <span className="personal-event-note-dot" aria-hidden="true" />
                  <p>{editingEventId
                    ? "Los participantes actuales se conservarán."
                    : "Este evento será personal y solo aparecerá en tu agenda."}</p>
                </div>
              ) : (
                <p className="event-form-error" role="alert">
                  {authError ?? "No se pudo verificar tu perfil y permiso. No puedes asignar trabajadores por ahora."}
                </p>
              )}

              <section className="reminder-group" aria-labelledby="reminder-title">
                <div className="reminder-heading">
                  <div>
                    <h4 id="reminder-title">Alerta</h4>
                    <p>Las notificaciones automáticas estarán disponibles más adelante.</p>
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
                      onChange={(event) => setFormData({ ...formData, reminderUnit: event.target.value as ReminderUnit })}
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
                <button className="btn-save" type="submit" disabled={isSaving || isLoadingWorkers}>
                  {isSaving ? "Guardando..." : "Guardar evento"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {eventPendingDeletion && <ConfirmDialog title="Eliminar evento" message={`¿Deseas eliminar “${eventPendingDeletion.title}”? Esta acción no se puede deshacer.`} onCancel={() => setEventToDelete(null)} onConfirm={() => { void handleDeleteEvent(eventPendingDeletion); }} />}
      {eventToView && <EventSummaryDialog event={eventToView} onClose={() => setEventToView(null)} />}
    </div>
  );
}

export default Principal;