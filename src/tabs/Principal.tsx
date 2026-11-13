import "./S-principal.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  Eye,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
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
import {
  completeCalendarOperation,
  deleteLocalSharedDraft,
  enqueueOfflineCancel,
  enqueueOfflineSave,
  markCalendarOperationAttempt,
  markCalendarOperationError,
  markCalendarOperationProblem,
  mergeCalendarEventsWithOutbox,
  readCachedAssignableWorkers,
  readLastSuccessfulCalendarSync,
  readCalendarOutbox,
  readCalendarSnapshot,
  recordSuccessfulCalendarSync,
  removeResolvedCalendarOperation,
  saveAuthorizedAssignableWorkers,
  saveCalendarSnapshot,
} from "../services/calendar-cache";
import type {
  AssignableWorker,
  CalendarEvent,
  CalendarOutboxOperation,
  CalendarOutboxSaveOperation,
  ReminderUnit,
  SaveCalendarEventInput,
} from "../types/calendar";

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
  const { status: authStatus, profile, user, error: authError } = useAuth();
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
  const [confirmedEvents, setConfirmedEvents] = useState<CalendarEvent[]>([]);
  const [calendarOperations, setCalendarOperations] = useState<CalendarOutboxOperation[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableWorker[]>([]);
  const [hasCachedAssignableUsers, setHasCachedAssignableUsers] = useState(false);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [retrySyncSequence, setRetrySyncSequence] = useState(0);
  const [lastSuccessfulSyncState, setLastSuccessfulSyncState] = useState<{ userId: string; at: string | null }>({
    userId: "",
    at: null,
  });
  const [loadError, setLoadError] = useState("");
  const [loadWarning, setLoadWarning] = useState("");
  const [realtimeWarning, setRealtimeWarning] = useState("");
  const [syncError, setSyncError] = useState("");
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
  const syncPanelRef = useRef<HTMLDivElement>(null);
  const loadedCalendarUserId = useRef("");
  const syncingUserIds = useRef(new Set<string>());
  const activeAuthenticatedUserId = useRef("");
  const eventPendingDeletion = events.find((event) => event.id === eventToDelete);
  const currentUserId = profile?.id ?? user?.id ?? "";
  const lastSuccessfulSyncAt = lastSuccessfulSyncState.userId === currentUserId
    ? lastSuccessfulSyncState.at
    : null;
  const canSyncCalendar = isOnline
    && window.navigator.onLine
    && authStatus === "authenticated"
    && !!profile;
  const canAssignEvents = canSyncCalendar
    && hasAdministrativePermission(profile, "can_assign_events");
  const canEditPersonalOffline = !!currentUserId
    && (authStatus === "offline" || !isOnline || !window.navigator.onLine);
  const canOpenEventForm = canSyncCalendar || canEditPersonalOffline;
  const isPersonalEvent = useCallback((event: CalendarEvent) =>
    event.createdBy.id === currentUserId && event.assignedWorkers.length === 0,
  [currentUserId]);
  const isSharedOwnedEvent = useCallback((eventId: string) => {
    const event = events.find((candidate) => candidate.id === eventId);
    return !!event
      && event.createdBy.id === currentUserId
      && (event.assignedWorkers.length > 0
        || calendarOperations.some((operation) => (
          operation.eventId === eventId
          && (operation.scope === "shared-update"
            || (operation.kind === "cancel" && operation.scope === "shared"))
        )));
  }, [calendarOperations, currentUserId, events]);
  const getSharedUpdateOperations = useCallback((eventId: string) => calendarOperations
    .filter((operation): operation is CalendarOutboxSaveOperation => (
      operation.kind === "save"
      && operation.scope === "shared-update"
      && operation.eventId === eventId
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  [calendarOperations]);
  const getSharedDraftOperation = useCallback((eventId: string) => calendarOperations
    .filter((operation) => (
      operation.kind === "save"
      && operation.scope === "shared"
      && operation.eventId === eventId
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-1)[0], [calendarOperations]);
  const isSharedDraft = useCallback((eventId: string) => !!getSharedDraftOperation(eventId), [getSharedDraftOperation]);
  const canAssignInCurrentForm = canAssignEvents || (
    canEditPersonalOffline
    && hasCachedAssignableUsers
    && (!editingEventId || isSharedDraft(editingEventId) || isSharedOwnedEvent(editingEventId))
  );

  useEffect(() => {
    activeAuthenticatedUserId.current = authStatus === "authenticated" ? profile?.id ?? "" : "";
  }, [authStatus, profile?.id]);

  useEffect(() => {
    let active = true;
    if (!currentUserId) return () => { active = false; };
    void readLastSuccessfulCalendarSync(currentUserId).then((lastSync) => {
      if (active) setLastSuccessfulSyncState({ userId: currentUserId, at: lastSync });
    }).catch(() => {
      if (active) setSyncError("No se pudo leer la última sincronización guardada.");
    });
    return () => {
      active = false;
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!syncPanelOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !syncPanelRef.current?.contains(event.target)) {
        setSyncPanelOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSyncPanelOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [syncPanelOpen]);

  const reloadEvents = useCallback(async (showLoading = true) => {
    const requestGeneration = ++eventLoadGeneration.current;
    if (!currentUserId) {
      setEvents([]);
      setConfirmedEvents([]);
      setCalendarOperations([]);
      setIsLoadingEvents(false);
      return false;
    }

    if (loadedCalendarUserId.current !== currentUserId) {
      loadedCalendarUserId.current = currentUserId;
      setEvents([]);
      setConfirmedEvents([]);
      setCalendarOperations([]);
    }

    if (showLoading) setIsLoadingEvents(true);
    setLoadError("");
    setLoadWarning("");

    if (authStatus === "offline" || !window.navigator.onLine) {
      try {
        const [cachedEvents, operations] = await Promise.all([
          readCalendarSnapshot(currentUserId),
          readCalendarOutbox(currentUserId),
        ]);
        if (requestGeneration !== eventLoadGeneration.current) return false;
        setCalendarOperations(operations);
        if (cachedEvents) {
          setEvents(mergeCalendarEventsWithOutbox(currentUserId, cachedEvents, cachedEvents, operations));
          return true;
        }
        setLoadError("No hay una copia de la agenda para esta cuenta en este equipo.");
        return false;
      } catch {
        if (requestGeneration === eventLoadGeneration.current) {
          setLoadError("No se pudo leer la agenda guardada en este equipo.");
        }
        return false;
      } finally {
        if (requestGeneration === eventLoadGeneration.current) {
          setIsLoadingEvents(false);
        }
      }
    }

    try {
      const result = await withCalendarLoadTimeout(listCalendarEvents());
      if (requestGeneration !== eventLoadGeneration.current) return false;
      try {
        await recordSuccessfulCalendarSync(currentUserId);
        if (requestGeneration === eventLoadGeneration.current) {
          setLastSuccessfulSyncState({
            userId: currentUserId,
            at: await readLastSuccessfulCalendarSync(currentUserId),
          });
        }
      } catch {
        if (requestGeneration === eventLoadGeneration.current) {
          setSyncError("La agenda se actualizó, pero no se pudo guardar la hora de sincronización.");
        }
      }
      const authorizedEvents = result.events.filter((event) =>
        event.createdBy.id === currentUserId
        || event.assignedWorkers.some((worker) => worker.id === currentUserId),
      );
      setConfirmedEvents(authorizedEvents);
      const [cachedEvents, operations] = await Promise.all([
        readCalendarSnapshot(currentUserId),
        readCalendarOutbox(currentUserId),
      ]);
      if (requestGeneration !== eventLoadGeneration.current) return false;
      setCalendarOperations(operations);
      const visibleEvents = mergeCalendarEventsWithOutbox(
        currentUserId,
        authorizedEvents,
        cachedEvents ?? [],
        operations,
      );
      setEvents(visibleEvents);
      try {
        await saveCalendarSnapshot(currentUserId, visibleEvents);
      } catch {
        if (requestGeneration === eventLoadGeneration.current) {
          setLoadWarning("Agenda actualizada, pero no se pudo guardar una copia en este equipo.");
        }
      }
      if (result.profileNamesUnavailable && requestGeneration === eventLoadGeneration.current) {
        setLoadWarning("No fue posible cargar el nombre de todos los organizadores o participantes. Actualiza la agenda o inténtalo más tarde.");
      }
      return true;
    } catch {
      if (requestGeneration === eventLoadGeneration.current) {
        try {
          const [cachedEvents, operations] = await Promise.all([
            readCalendarSnapshot(currentUserId),
            readCalendarOutbox(currentUserId),
          ]);
          if (requestGeneration !== eventLoadGeneration.current) return false;
          setCalendarOperations(operations);
          if (cachedEvents) {
            setEvents(mergeCalendarEventsWithOutbox(currentUserId, cachedEvents, cachedEvents, operations));
            setLoadError("");
            setLoadWarning("No hay conexión. Se muestra la agenda guardada en este equipo.");
            return true;
          }
        } catch {
          if (requestGeneration === eventLoadGeneration.current) {
            setLoadError("No se pudo cargar la agenda ni leer la copia guardada en este equipo.");
            return false;
          }
        }
        if (requestGeneration === eventLoadGeneration.current) {
          setLoadError("No se pudo cargar la agenda y no hay una copia guardada para esta cuenta.");
        }
      }
      return false;
    } finally {
      if (requestGeneration === eventLoadGeneration.current) {
        setIsLoadingEvents(false);
      }
    }
  }, [authStatus, currentUserId]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      const editingEvent = events.find((event) => event.id === editingEventId);
      if (editingEvent && !isPersonalEvent(editingEvent)) {
        setFormError("Sin conexión, los eventos compartidos solo se pueden consultar.");
      }
      void reloadEvents(false);
    };
    const handleOnline = () => {
      setIsOnline(true);
      void reloadEvents(false);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [editingEventId, events, isPersonalEvent, reloadEvents]);

  useEffect(() => {
    const authenticatedUserId = profile?.id;
    if (authStatus === "authenticated" && authenticatedUserId) {
      let active = true;
      let hasSubscribed = false;
      queueMicrotask(() => {
        if (active) void reloadEvents();
      });
      const channel = subscribeToCalendarChanges(
        authenticatedUserId,
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

    if (authStatus === "offline" && user?.id) {
      let active = true;
      queueMicrotask(() => {
        if (active) void reloadEvents();
      });
      return () => {
        active = false;
        eventLoadGeneration.current += 1;
      };
    }

    eventLoadGeneration.current += 1;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setEvents([]);
      setConfirmedEvents([]);
      setCalendarOperations([]);
      setIsLoadingEvents(false);
      setLoadError("");
      setLoadWarning("");
      setRealtimeWarning("");
      setSyncError("");
    });
    return () => {
      active = false;
      eventLoadGeneration.current += 1;
    };
  }, [authStatus, profile?.id, user?.id, reloadEvents]);

  const syncProfileId = profile?.id;
  useEffect(() => {
    if (!canSyncCalendar || !syncProfileId) return;
    const userId = syncProfileId;
    let active = true;

    const syncPendingOperations = async () => {
      if (syncingUserIds.current.has(userId) || !window.navigator.onLine) return;
      syncingUserIds.current.add(userId);
      setIsSyncing(true);
      const blockedEventIds = new Set<string>();
      try {
        const operations = await readCalendarOutbox(userId);
        if (!active) return;
        setCalendarOperations(operations);
        for (const operation of operations) {
          if (!active) return;
          if (operation.status === "conflict") {
            const conflictsForEvent = operations
              .filter((candidate) => (
                candidate.eventId === operation.eventId && candidate.status === "conflict"
              ))
              .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
            const latestConflict = conflictsForEvent[conflictsForEvent.length - 1];
            if (latestConflict?.operationId !== operation.operationId) continue;
            const hasPendingResolution = operations.some((candidate) => (
              candidate.eventId === operation.eventId
              && candidate.kind === "save"
              && candidate.status === "pending"
              && (candidate.input.resolvesOperationId === operation.operationId
                || candidate.supersedesOperationId === operation.operationId)
            ));
            if (!hasPendingResolution) blockedEventIds.add(operation.eventId);
            continue;
          }
          if (operation.status === "rejected") {
            if (operation.kind === "save" && operation.scope === "shared-update") {
              const hasSupersedingUpdate = operations.some((candidate) => (
                candidate.kind === "save"
                && candidate.scope === "shared-update"
                && candidate.eventId === operation.eventId
                && candidate.status === "pending"
                && candidate.supersedesOperationId === operation.operationId
              ));
              if (!hasSupersedingUpdate) blockedEventIds.add(operation.eventId);
            }
            continue;
          }
          if (blockedEventIds.has(operation.eventId)) continue;
          if (!window.navigator.onLine) break;

          let result;
          try {
            if (
              operation.kind === "save"
              && (operation.scope === "shared" || operation.scope === "shared-update")
            ) {
              await markCalendarOperationAttempt(userId, operation.operationId);
            }
            result = operation.kind === "save"
              ? await saveCalendarEvent(operation.input)
              : await cancelCalendarEvent(
                operation.operationId,
                operation.eventId,
                operation.expectedVersion,
                operation.resolvesOperationId,
              );
          } catch {
            if (!active) return;
            await markCalendarOperationError(userId, operation.operationId, "No se pudo contactar con el servidor.");
            blockedEventIds.add(operation.eventId);
            setSyncError("Hay cambios pendientes. Se volverán a intentar cuando la conexión esté disponible.");
            if (!window.navigator.onLine) break;
            continue;
          }

          if (result.status === "confirmed") {
            await completeCalendarOperation(
              userId,
              operation,
              result.version,
              operation.kind === "save"
                ? operation.input.resolvesOperationId ?? null
                : operation.resolvesOperationId,
            );
            try {
              await recordSuccessfulCalendarSync(userId);
              setLastSuccessfulSyncState({
                userId,
                at: await readLastSuccessfulCalendarSync(userId),
              });
            } catch {
              setSyncError("Una operación se sincronizó, pero no se pudo guardar la hora de sincronización.");
            }
            if (!active) return;
            continue;
          }

          if (!active) return;
          await markCalendarOperationProblem(
            userId,
            operation.operationId,
            result.status,
            result.code,
          );
          blockedEventIds.add(operation.eventId);
          setSyncError(result.status === "conflict"
            ? "Hay cambios con conflicto. Revisa los eventos marcados antes de continuar."
            : "No se pudo aplicar uno o más cambios. Revisa los eventos marcados.");
        }

        const remainingOperations = await readCalendarOutbox(userId);
        if (!active) return;
        setCalendarOperations(remainingOperations);
        const hasConflicts = remainingOperations.some((operation) => operation.status === "conflict");
        const hasRejections = remainingOperations.some((operation) => operation.status === "rejected");
        const hasNetworkErrors = remainingOperations.some((operation) => !!operation.lastError);
        setSyncError(hasConflicts
          ? "Hay cambios con conflicto. Revisa los eventos marcados antes de continuar."
          : hasRejections
            ? "No se pudo aplicar uno o más cambios. Revisa los eventos marcados."
            : hasNetworkErrors
              ? "Hay cambios pendientes. Se volverán a intentar cuando la conexión esté disponible."
              : "");
        await reloadEvents(false);
      } catch {
        if (active) {
          setSyncError("No se pudo completar la sincronización. Los cambios se conservaron en este equipo.");
        }
      } finally {
        syncingUserIds.current.delete(userId);
        if (active) setIsSyncing(false);
      }
    };

    void syncPendingOperations();
    const retryTimer = window.setInterval(() => {
      if (window.navigator.onLine) void syncPendingOperations();
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(retryTimer);
    };
  }, [canSyncCalendar, syncProfileId, reloadEvents, retrySyncSequence]);

  const assignerProfileId = profile?.id;
  useEffect(() => {
    if (!modalOpen || !currentUserId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setIsLoadingWorkers(true);
      setWorkerLoadError("");
      if (canAssignEvents && assignerProfileId) {
        void listAssignableWorkers(assignerProfileId).then(async (workers) => {
          if (!active) return;
          setAssignableUsers(workers);
          setHasCachedAssignableUsers(true);
          try {
            await saveAuthorizedAssignableWorkers(currentUserId, workers);
          } catch {
            if (active) setSyncError("No se pudo guardar la lista de trabajadores para preparar borradores sin conexión.");
          }
        }).catch(() => {
          if (active) {
            setAssignableUsers([]);
            setHasCachedAssignableUsers(false);
            setWorkerLoadError("No se pudo consultar la lista de trabajadores autorizada.");
          }
        }).finally(() => {
          if (active) setIsLoadingWorkers(false);
        });
      } else if (canEditPersonalOffline) {
        void readCachedAssignableWorkers(currentUserId).then((workers) => {
          if (!active) return;
          setHasCachedAssignableUsers(workers !== null);
          setAssignableUsers(workers ?? []);
        }).catch(() => {
          if (active) {
            setAssignableUsers([]);
            setHasCachedAssignableUsers(false);
            setSyncError("No se pudo leer la lista autorizada de trabajadores guardada.");
          }
        }).finally(() => {
          if (active) setIsLoadingWorkers(false);
        });
      } else {
        setAssignableUsers([]);
        setHasCachedAssignableUsers(false);
        setIsLoadingWorkers(false);
      }
    });
    return () => {
      active = false;
    };
  }, [modalOpen, canAssignEvents, canEditPersonalOffline, assignerProfileId, currentUserId]);

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
    if (!canOpenEventForm) return;
    if (typeof dayNumber === "number") {
      setSelectedDate(new Date(year, month, dayNumber));
    }

    setEditingEventId(null);
    setDraftEventId((current) => current ?? crypto.randomUUID());
    setAssignableUsers([]);
    setHasCachedAssignableUsers(false);
    setIsLoadingWorkers(true);
    setWorkerLoadError("");
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
    if (!currentUserId || isSaving) return;
    if (!canSyncCalendar && !canEditPersonalOffline) {
      setFormError("No se pudo validar la cuenta para guardar el cambio.");
      return;
    }
    const existingEvent = events.find((event) => event.id === editingEventId);
    if (canSyncCalendar && !profile) return;
    const sharedDraftOperation = existingEvent ? getSharedDraftOperation(existingEvent.id) : undefined;
    const sharedUpdateOperations = existingEvent ? getSharedUpdateOperations(existingEvent.id) : [];
    const sharedUpdateIssue = [...sharedUpdateOperations]
      .filter((operation) => operation.status === "conflict" || operation.status === "rejected")
      .pop();
    const pendingSharedUpdate = [...sharedUpdateOperations]
      .filter((operation) => operation.status === "pending")
      .pop();
    const pendingSharedResolution = sharedUpdateIssue
      ? sharedUpdateOperations.find((operation) => (
        operation.status === "pending"
        && (operation.input.resolvesOperationId === sharedUpdateIssue.operationId
          || operation.supersedesOperationId === sharedUpdateIssue.operationId)
      ))
      : undefined;
    const needsSharedUpdateResolution = !!sharedUpdateIssue && !pendingSharedResolution;
    const isSharedEventUpdate = !!existingEvent
      && !isPersonalEvent(existingEvent)
      && !sharedDraftOperation
      && isSharedOwnedEvent(existingEvent.id);
    if (
      isSharedEventUpdate
      && !sharedUpdateIssue
      && calendarOperations.some((operation) => (
        operation.eventId === existingEvent?.id
        && operation.kind === "cancel"
        && operation.scope === "shared"
        && operation.status === "pending"
      ))
    ) {
      setFormError("La cancelación de este evento está pendiente de confirmación.");
      return;
    }
    if (
      !canSyncCalendar
      && existingEvent
      && !isPersonalEvent(existingEvent)
      && !sharedDraftOperation
      && !isSharedEventUpdate
    ) {
      setFormError("Sin conexión, solo puedes modificar eventos compartidos propios y personales.");
      return;
    }
    if (needsSharedUpdateResolution && !canSyncCalendar) {
      setFormError("Conéctate para revisar la versión confirmada y resolver el problema antes de editar este evento.");
      return;
    }
    if (
      sharedDraftOperation?.kind === "save"
      && sharedDraftOperation.status === "pending"
      && sharedDraftOperation.attempted
    ) {
      setFormError("Este borrador ya se intentó sincronizar. Reintenta o espera el resultado antes de editarlo.");
      return;
    }
    if (
      !canSyncCalendar
      && existingEvent
      && !sharedDraftOperation
      && !isSharedEventUpdate
      && calendarOperations.some((operation) => (
        operation.eventId === existingEvent.id && operation.status === "conflict"
      ))
    ) {
      setFormError("Este evento tiene un conflicto pendiente. Conéctate para revisarlo antes de modificarlo.");
      return;
    }
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
    if ((canAssignEvents || canAssignInCurrentForm) && participantIdsChanged && workerLoadError) {
      setFormError("No se pudo verificar la lista de trabajadores. Inténtalo nuevamente.");
      return;
    }
    if (sharedDraftOperation && formData.assignedWorkerIds.length === 0) {
      setFormError("Un borrador compartido debe conservar al menos un trabajador asignado.");
      return;
    }
    if (
      !canSyncCalendar
      && existingEvent
      && isPersonalEvent(existingEvent)
      && formData.assignedWorkerIds.length > 0
    ) {
      setFormError("Sin conexión no puedes convertir un evento personal existente en compartido.");
      return;
    }

    setFormError("");
    setIsSaving(true);
    const eventId = existingEvent?.id ?? draftEventId ?? crypto.randomUUID();
    const storedSaveConflicts = calendarOperations
      .filter((operation) => (
        operation.eventId === eventId && operation.kind === "save" && operation.status === "conflict"
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const storedSaveConflict = storedSaveConflicts[storedSaveConflicts.length - 1];
    const storedRejectedCreates = calendarOperations
      .filter((operation) => (
        operation.eventId === eventId
        && operation.kind === "save"
        && operation.status === "rejected"
        && operation.input.expectedVersion === 0
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const storedRejectedCreate = storedRejectedCreates[storedRejectedCreates.length - 1];
    const isCreateRetry = (
      storedSaveConflict?.kind === "save" && storedSaveConflict.input.expectedVersion === 0
    ) || (
      storedRejectedCreate?.kind === "save" && storedRejectedCreate.input.expectedVersion === 0
    );
    const resolvesOperationId = storedSaveConflict?.operationId
      ?? (pendingSaveConflict?.eventId === eventId ? pendingSaveConflict.operationId : null);
    const sharedServerEvent = existingEvent
      ? confirmedEvents.find((event) => event.id === existingEvent.id)
      : undefined;
    if (needsSharedUpdateResolution && !sharedServerEvent) {
      setIsSaving(false);
      setFormError("Actualiza la agenda con conexión antes de resolver este cambio.");
      return;
    }
    const coalesceSharedUpdate = !!pendingSharedUpdate
      && !pendingSharedUpdate.attempted
      && !needsSharedUpdateResolution;
    const sharedUpdateExpectedVersion = needsSharedUpdateResolution
      ? sharedServerEvent?.version
      : coalesceSharedUpdate
        ? pendingSharedUpdate.input.expectedVersion
        : existingEvent?.version;
    const sharedUpdateResolvesOperationId = coalesceSharedUpdate
      ? pendingSharedUpdate.input.resolvesOperationId ?? null
      : needsSharedUpdateResolution && sharedUpdateIssue?.status === "conflict"
        ? sharedUpdateIssue.operationId
        : null;
    const sharedUpdateSupersedesOperationId = coalesceSharedUpdate
      ? pendingSharedUpdate.supersedesOperationId ?? null
      : needsSharedUpdateResolution && sharedUpdateIssue?.status === "rejected"
        ? sharedUpdateIssue.operationId
        : null;
    const request: Omit<SaveCalendarEventInput, "operationId"> = {
      eventId,
      expectedVersion: sharedDraftOperation || isCreateRetry
        ? 0
        : isSharedEventUpdate
          ? sharedUpdateExpectedVersion ?? existingEvent?.version ?? 0
          : existingEvent?.version ?? 0,
      title: formData.title.trim(),
      description: formData.description.trim(),
      category: formData.category,
      date: eventDate,
      startTime: formData.startTime,
      endTime: formData.endTime,
      participantIds: canAssignInCurrentForm
        ? (existingEvent && !sharedDraftOperation && !participantIdsChanged
          ? null
          : formData.assignedWorkerIds)
        : sharedDraftOperation
          ? formData.assignedWorkerIds
          : isSharedEventUpdate || (existingEvent && !isPersonalEvent(existingEvent))
            ? null
            : canSyncCalendar ? null : [],
      reminderEnabled: formData.reminderEnabled,
      reminderValue: formData.reminderEnabled ? formData.reminderValue : null,
      reminderUnit: formData.reminderEnabled ? formData.reminderUnit : null,
      resolvesOperationId: isSharedEventUpdate
        ? sharedUpdateResolvesOperationId
        : resolvesOperationId,
    };
    const fingerprint = JSON.stringify(request);
    const pendingSharedDraft = sharedDraftOperation?.kind === "save"
      && sharedDraftOperation.status === "pending"
      && !sharedDraftOperation.attempted
      ? sharedDraftOperation
      : undefined;
    const operationId = pendingSharedDraft?.operationId
      ?? (coalesceSharedUpdate ? pendingSharedUpdate.operationId : undefined)
      ?? (canSyncCalendar && pendingSaveRequest?.fingerprint === fingerprint
        ? pendingSaveRequest.operationId
        : crypto.randomUUID());

    const queueSharedDraft = !!sharedDraftOperation
      || (!canSyncCalendar && !existingEvent && formData.assignedWorkerIds.length > 0);
    const queueSharedUpdate = isSharedEventUpdate;
    const shouldQueueSave = queueSharedDraft || queueSharedUpdate || !canSyncCalendar
      || (
        (request.participantIds === null || request.participantIds.length === 0)
        && (!existingEvent || isPersonalEvent(existingEvent))
      );
    if (shouldQueueSave) {
      const ownerName = existingEvent?.createdBy.name
        || events.find((event) => event.createdBy.id === currentUserId)?.createdBy.name
        || profile?.full_name
        || "Nombre no disponible";
      const eventSnapshot: CalendarEvent = {
        id: eventId,
        version: request.expectedVersion + 1,
        title: request.title,
        description: request.description,
        category: request.category,
        date: request.date,
        startTime: request.startTime,
        endTime: request.endTime,
        reminderEnabled: request.reminderEnabled,
        reminderValue: request.reminderValue ?? 0,
        reminderUnit: request.reminderUnit ?? "minutes",
        createdBy: { id: currentUserId, name: ownerName },
        assignedWorkers: queueSharedDraft || queueSharedUpdate
          ? formData.assignedWorkerIds.flatMap((id) => {
            const worker = assignableUsers.find((candidate) => candidate.id === id)
              ?? existingEvent?.assignedWorkers.find((candidate) => candidate.id === id);
            return worker ? [{ id: worker.id, name: worker.name }] : [];
          })
          : [],
      };
      try {
        const queuedInput: SaveCalendarEventInput = {
          operationId,
          ...request,
          participantIds: queueSharedDraft
            ? formData.assignedWorkerIds
            : queueSharedUpdate ? request.participantIds : [],
        };
        if ((queueSharedDraft || (queueSharedUpdate && request.participantIds !== null))
          && eventSnapshot.assignedWorkers.length !== formData.assignedWorkerIds.length) {
          throw new Error("No se encontró la lista autorizada de trabajadores necesaria para este borrador.");
        }
        const priorOperations = await readCalendarOutbox(currentUserId);
        await enqueueOfflineSave(
          currentUserId,
          queuedInput,
          eventSnapshot,
          queueSharedDraft ? "shared" : queueSharedUpdate ? "shared-update" : "personal",
          queueSharedUpdate ? sharedUpdateSupersedesOperationId : null,
        );

        if (
          canSyncCalendar
          && !syncingUserIds.current.has(currentUserId)
          && !priorOperations.some((operation) => (
            operation.eventId === eventId
            && operation.operationId !== operationId
            && operation.status === "pending"
          ))
        ) {
          syncingUserIds.current.add(currentUserId);
          setIsSyncing(true);
          try {
            if (queueSharedDraft || queueSharedUpdate) {
              await markCalendarOperationAttempt(currentUserId, operationId);
            }
            const result = await saveCalendarEvent(queuedInput);
            if (activeAuthenticatedUserId.current !== currentUserId) return;
            if (result.status === "confirmed") {
              await completeCalendarOperation(
                currentUserId,
                {
                  userId: currentUserId,
                  operationId,
                  eventId,
                  kind: "save",
                  scope: queueSharedDraft ? "shared" : queueSharedUpdate ? "shared-update" : "personal",
                  input: queuedInput,
                  eventSnapshot,
                  status: "pending",
                  supersedesOperationId: queueSharedUpdate ? sharedUpdateSupersedesOperationId : null,
                  createdAt: new Date().toISOString(),
                },
                result.version,
                resolvesOperationId,
              );
              try {
                await recordSuccessfulCalendarSync(currentUserId);
                setLastSuccessfulSyncState({
                  userId: currentUserId,
                  at: await readLastSuccessfulCalendarSync(currentUserId),
                });
                setSyncError("");
              } catch {
                setSyncError("El evento se sincronizó, pero no se pudo guardar la hora de sincronización.");
              }
              setPendingSaveConflict(null);
            } else {
              await markCalendarOperationProblem(
                currentUserId,
                operationId,
                result.status,
                result.code,
              );
              if (result.status === "conflict") {
                setPendingSaveConflict({ eventId, operationId });
              }
              setSyncError(getCalendarOperationMessage(result));
            }
          } catch {
            if (activeAuthenticatedUserId.current !== currentUserId) return;
            await markCalendarOperationError(
              currentUserId,
              operationId,
              "No se pudo contactar con el servidor.",
            );
            setSyncError("El cambio se conservó en este equipo y se volverá a intentar.");
          } finally {
            syncingUserIds.current.delete(currentUserId);
            setIsSyncing(false);
          }
        }

        const [cachedEvents, operations] = await Promise.all([
          readCalendarSnapshot(currentUserId),
          readCalendarOutbox(currentUserId),
        ]);
        if (cachedEvents) setEvents(cachedEvents);
        setCalendarOperations(operations);
        setDraftEventId(null);
        setPendingSaveRequest(null);
        closeModal();
        if (canSyncCalendar) await reloadEvents(false);
      } catch (error) {
        setFormError(error instanceof Error
          ? error.message
          : "No se pudo guardar el cambio en este equipo. El evento no se modificó.");
      } finally {
        setIsSaving(false);
      }
      return;
    }

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
      if (resolvesOperationId) {
        await removeResolvedCalendarOperation(currentUserId, resolvesOperationId);
        setCalendarOperations(await readCalendarOutbox(currentUserId));
      }
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
  const pendingOperationCount = calendarOperations.filter((operation) => operation.status === "pending").length;
  const personalPendingCount = calendarOperations.filter((operation) =>
    operation.status === "pending"
    && (operation.scope === undefined || operation.scope === "personal"),
  ).length;
  const sharedDraftCount = new Set(
    calendarOperations
      .filter((operation) => operation.kind === "save" && operation.scope === "shared")
      .map((operation) => operation.eventId),
  ).size;
  const sharedUpdateCount = new Set(
    calendarOperations
      .filter((operation) => operation.kind === "save" && operation.scope === "shared-update")
      .map((operation) => operation.eventId),
  ).size;
  const sharedCancelCount = new Set(
    calendarOperations
      .filter((operation) => operation.kind === "cancel" && operation.scope === "shared")
      .map((operation) => operation.eventId),
  ).size;
  const panelOperations = [...calendarOperations]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const attentionOperationCount = panelOperations.filter((operation) => operation.status !== "pending").length;
  const hasSyncAttention = attentionOperationCount > 0
    || !!loadError
    || !!loadWarning
    || !!realtimeWarning
    || !!syncError;
  const isConnectionAvailable = isOnline && window.navigator.onLine;
  const getEventSyncOperation = (eventId: string) => {
    const matchingOperations = calendarOperations
      .filter((operation) => operation.eventId === eventId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return matchingOperations[matchingOperations.length - 1];
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
    const sharedDraftOperation = getSharedDraftOperation(event.id);
    const hasPendingSharedCancel = calendarOperations.some((operation) => (
      operation.eventId === event.id
      && operation.kind === "cancel"
      && operation.scope === "shared"
      && operation.status === "pending"
    ));
    const hasSharedUpdateIssue = getSharedUpdateOperations(event.id).some((operation) => (
      operation.status === "conflict" || operation.status === "rejected"
    ));
    if (hasPendingSharedCancel && !hasSharedUpdateIssue) {
      setLoadError("La cancelación de este evento está pendiente de confirmación.");
      return;
    }
    if (
      !canOpenEventForm
      || (!canSyncCalendar
        && !isPersonalEvent(event)
        && !sharedDraftOperation
        && !isSharedOwnedEvent(event.id))
    ) return;
    if (
      sharedDraftOperation?.kind === "save"
      && sharedDraftOperation.status === "pending"
      && sharedDraftOperation.attempted
    ) {
      setLoadError("Este borrador ya se intentó sincronizar. Reintenta o espera el resultado antes de editarlo.");
      return;
    }
    if (
      !canSyncCalendar
      && !sharedDraftOperation
      && calendarOperations.some((operation) => (
        operation.eventId === event.id && operation.status === "conflict"
      ))
    ) {
      setLoadError("Este evento tiene un conflicto pendiente. Conéctate para revisarlo antes de modificarlo.");
      return;
    }
    setEditingEventId(event.id);
    setAssignableUsers([]);
    setHasCachedAssignableUsers(false);
    setIsLoadingWorkers(true);
    setWorkerLoadError("");
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
    const saveConflicts = calendarOperations
      .filter((operation) => (
        operation.eventId === event.id && operation.kind === "save" && operation.status === "conflict"
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const saveConflict = saveConflicts[saveConflicts.length - 1];
    setPendingSaveConflict(saveConflict
      ? { eventId: event.id, operationId: saveConflict.operationId }
      : null);
    setSelectedDate(new Date(Number(event.date.split("-")[0]), Number(event.date.split("-")[1]) - 1, Number(event.date.split("-")[2])));
    setModalOpen(true);
  };

  const handleDeleteEvent = async (event: CalendarEvent) => {
    const sharedDraftOperation = getSharedDraftOperation(event.id);
    if (calendarOperations.some((operation) => (
      operation.eventId === event.id
      && operation.kind === "cancel"
      && operation.status === "pending"
    ))) {
      setLoadError("La cancelación de este evento ya está pendiente.");
      return;
    }
    if (!currentUserId || (!canSyncCalendar
      && (!canEditPersonalOffline
        || (!isPersonalEvent(event) && !sharedDraftOperation && !isSharedOwnedEvent(event.id))))) {
      setLoadError("Sin conexión, solo puedes cancelar eventos personales propios.");
      return;
    }
    if (isSaving) return;
    if (sharedDraftOperation?.kind === "save") {
      setIsSaving(true);
      setLoadError("");
      try {
        await deleteLocalSharedDraft(currentUserId, event.id, sharedDraftOperation.operationId);
        const [cachedEvents, operations] = await Promise.all([
          readCalendarSnapshot(currentUserId),
          readCalendarOutbox(currentUserId),
        ]);
        if (cachedEvents) setEvents(cachedEvents);
        setCalendarOperations(operations);
        setEventToDelete(null);
      } catch (error) {
        setLoadError(error instanceof Error
          ? error.message
          : "No se pudo eliminar el borrador local.");
      } finally {
        setIsSaving(false);
      }
      return;
    }
    if (
      !canSyncCalendar
      && calendarOperations.some((operation) => (
        operation.eventId === event.id && operation.status === "conflict"
      ))
    ) {
      setLoadError("Este evento tiene un conflicto pendiente. Conéctate para revisarlo antes de cancelarlo.");
      return;
    }
    const storedCancelConflicts = calendarOperations
      .filter((operation) => (
        operation.eventId === event.id && operation.kind === "cancel" && operation.status === "conflict"
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const storedCancelConflict = storedCancelConflicts[storedCancelConflicts.length - 1];
    const resolvesOperationId = storedCancelConflict?.operationId
      ?? (pendingCancelConflict?.eventId === event.id ? pendingCancelConflict.operationId : null);

    const sharedEventCancellation = !isPersonalEvent(event) && !sharedDraftOperation;
    const shouldQueueCancel = !canSyncCalendar || isPersonalEvent(event) || isSharedOwnedEvent(event.id);
    if (shouldQueueCancel) {
      setIsSaving(true);
      setLoadError("");
      try {
        const priorOperations = await readCalendarOutbox(currentUserId);
        const operationId = crypto.randomUUID();
        const operation: CalendarOutboxOperation = {
          userId: currentUserId,
          operationId,
          eventId: event.id,
          kind: "cancel",
          scope: sharedEventCancellation ? "shared" : "personal",
          expectedVersion: event.version,
          resolvesOperationId,
          eventSnapshot: event,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        await enqueueOfflineCancel(currentUserId, {
          userId: currentUserId,
          operationId,
          eventId: event.id,
          kind: "cancel",
          scope: sharedEventCancellation ? "shared" : "personal",
          expectedVersion: event.version,
          resolvesOperationId,
          eventSnapshot: event,
        });
        if (
          canSyncCalendar
          && !syncingUserIds.current.has(currentUserId)
          && !priorOperations.some((pendingOperation) => (
            pendingOperation.eventId === event.id && pendingOperation.status === "pending"
          ))
        ) {
          syncingUserIds.current.add(currentUserId);
          setIsSyncing(true);
          try {
            const result = await cancelCalendarEvent(
              operationId,
              event.id,
              event.version,
              resolvesOperationId,
            );
            if (activeAuthenticatedUserId.current !== currentUserId) return;
            if (result.status === "confirmed") {
              await completeCalendarOperation(
                currentUserId,
                operation,
                result.version,
                resolvesOperationId,
              );
              setPendingCancelConflict(null);
            } else {
              await markCalendarOperationProblem(
                currentUserId,
                operationId,
                result.status,
                result.code,
              );
              if (result.status === "conflict") {
                setPendingCancelConflict({ eventId: event.id, operationId });
              }
              setSyncError(getCalendarOperationMessage(result));
            }
          } catch {
            if (activeAuthenticatedUserId.current !== currentUserId) return;
            await markCalendarOperationError(
              currentUserId,
              operationId,
              "No se pudo contactar con el servidor.",
            );
            setSyncError("La cancelación se conservó en este equipo y se volverá a intentar.");
          } finally {
            syncingUserIds.current.delete(currentUserId);
            setIsSyncing(false);
          }
        }
        const [cachedEvents, operations] = await Promise.all([
          readCalendarSnapshot(currentUserId),
          readCalendarOutbox(currentUserId),
        ]);
        if (cachedEvents) setEvents(cachedEvents);
        setCalendarOperations(operations);
        const operationStillPending = operations.some((pendingOperation) =>
          pendingOperation.operationId === operationId && pendingOperation.status === "pending",
        );
        if (!canSyncCalendar || operationStillPending) {
          setLoadWarning("Cancelación guardada en este equipo. Quedará pendiente de sincronización.");
        }
        setEventToDelete(null);
        if (canSyncCalendar) await reloadEvents(false);
      } catch {
        setLoadError("No se pudo guardar la cancelación en este equipo. El evento no se modificó.");
      } finally {
        setIsSaving(false);
      }
      return;
    }
    if (!profile) return;
    setIsSaving(true);
    setLoadError("");
    try {
      const request = {
        eventId: event.id,
        expectedVersion: event.version,
        resolvesOperationId,
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
      if (resolvesOperationId) {
        await removeResolvedCalendarOperation(currentUserId, resolvesOperationId);
        setCalendarOperations(await readCalendarOutbox(currentUserId));
      }
      setEventToDelete(null);
      await reloadEvents();
    } catch {
      setLoadError("No se pudo cancelar el evento. Comprueba tu conexión e inténtalo nuevamente.");
    } finally {
      setIsSaving(false);
    }
  };

  const correctSyncOperation = (operation: CalendarOutboxOperation) => {
    setSyncPanelOpen(false);
    const event = events.find((candidate) => candidate.id === operation.eventId)
      ?? operation.eventSnapshot;
    if (operation.kind === "save") {
      handleEditEvent(event);
    } else {
      setEventToDelete(event.id);
    }
  };

  const panelWarnings = [...new Set([loadError, loadWarning, realtimeWarning, syncError].filter(Boolean))];
  const sharedUpdateResolution = editingEventId
    ? [...getSharedUpdateOperations(editingEventId)]
      .filter((operation) => operation.status === "conflict" || operation.status === "rejected")
      .pop()
    : undefined;
  const sharedConfirmedEvent = editingEventId
    ? confirmedEvents.find((event) => event.id === editingEventId)
    : undefined;
  const syncStatusLabel = !isConnectionAvailable
    ? "Sin conexión"
    : isSyncing
      ? "Sincronizando"
      : pendingOperationCount
        ? "Pendiente de sincronización"
        : hasSyncAttention
          ? "Requiere atención"
          : "Todo sincronizado";

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
                {filteredEvents.map((event) => {
                  const syncOperation = getEventSyncOperation(event.id);
                  return (
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
                        {isSharedDraft(event.id)
                          ? "Borrador compartido"
                          : event.assignedWorkers.length > 0 ? "Compartido" : "Personal"}
                      </span>
                      {syncOperation && (
                        <span className="event-scope-pill" role="status">
                          {syncOperation.status === "pending"
                            ? syncOperation.kind === "cancel"
                              ? "Cancelación pendiente"
                              : syncOperation.scope === "shared-update"
                                ? "Actualización pendiente"
                                : "Pendiente de sincronización"
                            : syncOperation.code
                              ? getCalendarOperationMessage({
                                status: syncOperation.status === "conflict" ? "conflict" : "rejected",
                                code: syncOperation.code,
                              })
                              : "Revisar sincronización"}
                        </span>
                      )}

                      <div className="event-actions">
                        <button className="action-btn summary-btn" type="button" onClick={() => setEventToView(event)} aria-label={`Ver resumen de ${event.title}`} title="Ver resumen">
                          <Eye size={16} aria-hidden="true" />
                        </button>
                        {event.createdBy.id === currentUserId && (
                          <>
                            <button className="action-btn edit-btn" type="button" disabled={!canSyncCalendar && !isPersonalEvent(event) && !isSharedDraft(event.id) && !isSharedOwnedEvent(event.id)} onClick={() => handleEditEvent(event)} aria-label={`Editar evento ${event.title}`} title="Editar evento">
                              <Pencil size={16} aria-hidden="true" />
                            </button>
                            <button className="action-btn delete-btn" type="button" disabled={isSaving || (!canSyncCalendar && !isPersonalEvent(event) && !isSharedDraft(event.id) && !isSharedOwnedEvent(event.id))} onClick={() => setEventToDelete(event.id)} aria-label={`Eliminar ${event.title}`}>
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="calendar-card">
            <div className="calendar-header">
              <div className="calendar-title-group">
                <h3>Calendario</h3>
                <div className="sync-panel-anchor" ref={syncPanelRef}>
                  <button
                    className={`sync-indicator ${!isConnectionAvailable ? "is-offline" : ""} ${hasSyncAttention ? "has-attention" : ""}`}
                    type="button"
                    aria-label={`Estado de sincronización: ${syncStatusLabel}. ${pendingOperationCount} operaciones pendientes.`}
                    aria-expanded={syncPanelOpen}
                    aria-haspopup="dialog"
                    onClick={() => setSyncPanelOpen((open) => !open)}
                  >
                    <span className="sync-indicator-icon" aria-hidden="true">
                      {!isConnectionAvailable ? (
                        <CloudOff size={19} />
                      ) : isSyncing ? (
                        <RefreshCw className={isSyncing ? "sync-spinning" : ""} size={18} />
                      ) : (
                        <>
                          <Cloud size={19} />
                          <Check className="sync-check-overlay" size={10} />
                        </>
                      )}
                      {hasSyncAttention && <AlertTriangle className="sync-alert-overlay" size={11} />}
                    </span>
                    {pendingOperationCount > 0 && (
                      <span className="sync-pending-count">{pendingOperationCount}</span>
                    )}
                  </button>
                  {syncPanelOpen && (
                    <div className="sync-panel" role="dialog" aria-label="Estado de sincronización">
                      <div className="sync-panel-heading">
                        <strong>Sincronización</strong>
                        <span className={`sync-connection-state ${isConnectionAvailable ? "connected" : "disconnected"}`}>
                          {isConnectionAvailable ? "Con conexión" : "Sin conexión"}
                        </span>
                      </div>
                      <p className="sync-status-line">{syncStatusLabel}</p>
                      <div className="sync-counts">
                        <span>Operaciones pendientes <strong>{pendingOperationCount}</strong></span>
                        <span>Eventos personales <strong>{personalPendingCount}</strong></span>
                        <span>Borradores compartidos <strong>{sharedDraftCount}</strong></span>
                        <span>Actualizaciones compartidas <strong>{sharedUpdateCount}</strong></span>
                        <span>Cancelaciones compartidas <strong>{sharedCancelCount}</strong></span>
                      </div>
                      {lastSuccessfulSyncAt && (
                        <p className="sync-last-success">
                          Última sincronización correcta: {new Date(lastSuccessfulSyncAt).toLocaleString("es-MX")}
                        </p>
                      )}
                      {panelWarnings.length > 0 && (
                        <div className="sync-panel-warnings" role="status">
                          {panelWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                        </div>
                      )}
                      {panelOperations.length > 0 && (
                        <div className="sync-operation-list">
                          {panelOperations.map((operation) => {
                            const isSharedDraftOperation = operation.scope === "shared";
                            const isSharedUpdateOperation = operation.kind === "save"
                              && operation.scope === "shared-update";
                            const canDeleteDraft = operation.kind === "save"
                              && isSharedDraftOperation
                              && (operation.status !== "pending" || !operation.attempted);
                            return (
                              <div className="sync-operation-item" key={operation.operationId}>
                                <div className="sync-operation-copy">
                                  <strong>{operation.eventSnapshot.title}</strong>
                                  <span>
                                    {operation.kind === "cancel"
                                      ? operation.scope === "shared" ? "Cancelación compartida" : "Cancelación personal"
                                      : isSharedDraftOperation
                                        ? "Borrador compartido"
                                        : isSharedUpdateOperation ? "Actualización compartida" : "Evento personal"}
                                    {" · "}
                                    {operation.status === "pending"
                                      ? operation.lastError ? "No se pudo enviar" : "Pendiente"
                                      : operation.status === "conflict" ? "Conflicto" : "Rechazado"}
                                  </span>
                                  {(operation.lastError || operation.code) && (
                                    <small>{operation.lastError ?? getCalendarOperationMessage({
                                      status: operation.status === "conflict" ? "conflict" : "rejected",
                                      code: operation.code ?? "unknown",
                                    })}</small>
                                  )}
                                </div>
                                <div className="sync-operation-actions">
                                  {operation.status === "pending" && (
                                    <button
                                      type="button"
                                      disabled={!canSyncCalendar || isSyncing}
                                      onClick={() => {
                                        setSyncPanelOpen(false);
                                        setRetrySyncSequence((sequence) => sequence + 1);
                                      }}
                                    >
                                      Reintentar
                                    </button>
                                  )}
                                  {operation.status !== "pending" && (
                                    <button
                                      type="button"
                                      disabled={!isSharedDraftOperation && !canSyncCalendar}
                                      onClick={() => correctSyncOperation(operation)}
                                    >
                                      {operation.kind === "cancel" ? "Revisar" : "Corregir"}
                                    </button>
                                  )}
                                  {canDeleteDraft && (
                                    <button
                                      type="button"
                                      className="sync-delete-draft"
                                      onClick={() => {
                                        setSyncPanelOpen(false);
                                        setEventToDelete(operation.eventId);
                                      }}
                                    >
                                      Eliminar
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <button
                        className="sync-now-button"
                        type="button"
                        disabled={!canSyncCalendar || isSyncing}
                        onClick={() => {
                          setRetrySyncSequence((sequence) => sequence + 1);
                          void reloadEvents(false);
                        }}
                      >
                        {isSyncing ? "Sincronizando..." : "Actualizar ahora"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
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
                      if (canOpenEventForm) openModal(cell.value as number);
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
                disabled={!canOpenEventForm}
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
              {sharedUpdateResolution && sharedConfirmedEvent && (
                <div className="sync-reconciliation-note" role="status">
                  La versión confirmada más reciente está para el {formatEventDate(sharedConfirmedEvent.date)},
                  {" "}{formatEventTime(sharedConfirmedEvent.startTime)}–{formatEventTime(sharedConfirmedEvent.endTime)}.
                  Tu modificación se conserva localmente; revisa estos datos antes de volver a guardar.
                </div>
              )}
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

              {canAssignInCurrentForm ? (
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
              ) : canEditPersonalOffline && isLoadingWorkers ? (
                <p className="assignees-empty">Consultando la lista guardada de trabajadores...</p>
              ) : canEditPersonalOffline ? (
                <div className="personal-event-note">
                  <span className="personal-event-note-dot" aria-hidden="true" />
                  <p>{editingEventId && events.some((event) => (
                    event.id === editingEventId && isPersonalEvent(event)
                  ))
                    ? "Los eventos personales existentes no se pueden convertir en compartidos sin conexión."
                    : !hasCachedAssignableUsers
                      ? "No hay una lista autorizada de trabajadores guardada. Conéctate antes para preparar un evento compartido."
                      : "La lista guardada no contiene trabajadores disponibles para asignar."}</p>
                </div>
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
                <button
                  className="btn-save"
                  type="submit"
                  disabled={
                    isSaving
                    || isLoadingWorkers
                    || !canOpenEventForm
                    || (!canSyncCalendar
                      && !!editingEventId
                      && !events.some((event) => event.id === editingEventId
                        && (
                          isPersonalEvent(event)
                          || isSharedDraft(event.id)
                          || isSharedOwnedEvent(event.id)
                        )))
                  }
                >
                  {isSaving ? "Guardando..." : "Guardar evento"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {eventPendingDeletion && <ConfirmDialog
        title={isSharedDraft(eventPendingDeletion.id) ? "Eliminar borrador compartido" : "Eliminar evento"}
        message={isSharedDraft(eventPendingDeletion.id)
          ? `¿Deseas eliminar el borrador “${eventPendingDeletion.title}” de este equipo? No se enviará a los participantes.`
          : `¿Deseas eliminar “${eventPendingDeletion.title}”? Esta acción no se puede deshacer.`}
        onCancel={() => setEventToDelete(null)}
        onConfirm={() => { void handleDeleteEvent(eventPendingDeletion); }}
      />}
      {eventToView && <EventSummaryDialog event={eventToView} onClose={() => setEventToView(null)} />}
    </div>
  );
}

export default Principal;