import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useAuth } from "../auth/useAuth";
import {
  removeCalendarChangesSubscription,
  listCalendarEvents,
  subscribeToCalendarChanges,
} from "../services/calendar";
import {
  mergeCalendarEventsWithOutbox,
  readCalendarOutbox,
  readCalendarSnapshot,
} from "../services/calendar-cache";
import { createEventReminderSchedules, type ScheduledEventReminder } from "../services/event-reminders";
import type { CalendarEvent, CalendarOutboxOperation } from "../types/calendar";

function EventReminderManager() {
  const { status, profile, user } = useAuth();
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const activeNativeUserId = useRef<string | null>(null);
  const userId = status === "authenticated"
    ? profile?.id ?? null
    : status === "offline"
      ? user?.id ?? null
      : null;

  useEffect(() => {
    const updateNetworkState = () => setIsOnline(window.navigator.onLine);
    window.addEventListener("online", updateNetworkState);
    window.addEventListener("offline", updateNetworkState);
    return () => {
      window.removeEventListener("online", updateNetworkState);
      window.removeEventListener("offline", updateNetworkState);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let active = true;
    let refreshPromise: Promise<void> | null = null;
    let pendingRefresh = false;
    let pendingRemoteRefresh = false;

    const updateNativeSchedule = async (
      events: CalendarEvent[],
      operations: CalendarOutboxOperation[],
    ) => {
      if (!userId || !active) return;
      const cancelledEventIds = new Set(operations
        .filter((operation) => operation.kind === "cancel" && operation.status === "pending")
        .map((operation) => operation.eventId));
      const reminders: ScheduledEventReminder[] = createEventReminderSchedules(
        events,
        userId,
        Date.now(),
        cancelledEventIds,
      );
      await invoke("replace_event_reminders", { userId, reminders });
    };

    const refreshOnce = async (refreshRemote: boolean) => {
      let cachedEvents: CalendarEvent[] = [];
      let operations: CalendarOutboxOperation[] = [];
      try {
        const [cachedSnapshot, cachedOperations] = await Promise.all([
          readCalendarSnapshot(userId!),
          readCalendarOutbox(userId!),
        ]);
        cachedEvents = cachedSnapshot ?? [];
        operations = cachedOperations;
      } catch (error) {
        console.warn("No se pudo leer la agenda local para los recordatorios.", error);
      }

      if (!active) return;
      let events = mergeCalendarEventsWithOutbox(userId!, cachedEvents, cachedEvents, operations);
      await updateNativeSchedule(events, operations).catch((error: unknown) => {
        console.error("No se pudo actualizar la programación nativa de recordatorios.", error);
      });

      if (!refreshRemote || status !== "authenticated" || !window.navigator.onLine) return;
      try {
        const result = await listCalendarEvents();
        if (!active) return;
        const authorizedEvents = result.events.filter((event) => (
          event.createdBy.id === userId
          || event.assignedWorkers.some((worker) => worker.id === userId)
        ));
        events = mergeCalendarEventsWithOutbox(
          userId!,
          authorizedEvents,
          cachedEvents,
          operations,
        );
        await updateNativeSchedule(events, operations);
      } catch (error) {
        console.warn("No se pudo actualizar la agenda remota de recordatorios; se conserva la copia local.", error);
      }
    };

    const refresh = (refreshRemote: boolean) => {
      if (!userId) return;
      if (refreshPromise) {
        pendingRefresh = true;
        pendingRemoteRefresh ||= refreshRemote;
        return;
      }
      refreshPromise = refreshOnce(refreshRemote)
        .catch((error: unknown) => {
          console.error("No se pudieron sincronizar los recordatorios de eventos.", error);
        })
        .finally(() => {
          refreshPromise = null;
          if (pendingRefresh && active) {
            const nextRemoteRefresh = pendingRemoteRefresh;
            pendingRefresh = false;
            pendingRemoteRefresh = false;
            refresh(nextRemoteRefresh);
          }
        });
    };

    if (status === "suspended") {
        if (activeNativeUserId.current !== null) {
          activeNativeUserId.current = null;
          void invoke("replace_event_reminders", { userId: null, reminders: [] }).catch((error: unknown) => {
            console.error("No se pudieron pausar los recordatorios de una cuenta suspendida.", error);
          });
        }
        return () => {
          active = false;
        };
    }

    if (activeNativeUserId.current !== userId) {
      activeNativeUserId.current = userId;
      void invoke("replace_event_reminders", { userId, reminders: [] }).catch((error: unknown) => {
        console.error("No se pudo cambiar la cuenta activa de recordatorios.", error);
      });
    }

    if (!userId) {
      return () => {
        active = false;
      };
    }

    refresh(status === "authenticated" && isOnline);
    const refreshInterval = window.setInterval(
      () => refresh(status === "authenticated" && isOnline),
      status === "authenticated" && isOnline ? 60_000 : 5_000,
    );
    const refreshWhenOnline = () => {
      setIsOnline(window.navigator.onLine);
      refresh(window.navigator.onLine && status === "authenticated");
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refresh(window.navigator.onLine && status === "authenticated");
      }
    };
    window.addEventListener("online", refreshWhenOnline);
    window.addEventListener("offline", refreshWhenOnline);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    let channel: ReturnType<typeof subscribeToCalendarChanges> | null = null;
    if (status === "authenticated" && isOnline) {
      channel = subscribeToCalendarChanges(
        userId,
        () => refresh(true),
        (channelStatus) => {
          if (channelStatus === "CHANNEL_ERROR" || channelStatus === "TIMED_OUT") {
            console.warn("La suscripción de cambios de agenda para recordatorios no está disponible.");
          }
        },
      );
    }

    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      window.removeEventListener("online", refreshWhenOnline);
      window.removeEventListener("offline", refreshWhenOnline);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (channel) void removeCalendarChangesSubscription(channel);
    };
  }, [isOnline, status, userId]);

  return null;
}

export default EventReminderManager;
