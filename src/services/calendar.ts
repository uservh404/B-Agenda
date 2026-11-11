import { supabase } from "../lib/supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type {
  AssignableWorker,
  CalendarEvent,
  CalendarOperationResult,
  SaveCalendarEventInput,
} from "../types/calendar";

interface EventRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  category: string;
  event_date: string;
  start_time: string;
  end_time: string;
  status: string;
  version: number;
  reminder_enabled: boolean;
  reminder_value: number | null;
  reminder_unit: "minutes" | "hours" | "days" | "weeks" | null;
}

interface ParticipantRow {
  event_id: string;
  user_id: string;
}

interface AssignableProfileRow {
  id: string;
  full_name: string;
  role: "administrador" | "empleado";
}

interface EventOrganizerRow {
  event_id: string;
  owner_id: string;
  full_name: string;
}

interface EventParticipantNameRow {
  event_id: string;
  user_id: string;
  full_name: string;
}

interface RpcResponse {
  status: "confirmed" | "conflict" | "rejected";
  event_id?: string;
  version?: number;
  code?: string;
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<RpcResponse>;
  return response.status === "confirmed"
    || response.status === "conflict"
    || response.status === "rejected";
}

function normalizeTime(value: string) {
  return value.slice(0, 5);
}

function getParticipantKey(eventId: string, userId: string) {
  return `${eventId}:${userId}`;
}

export type CalendarRealtimeStatus =
  | "SUBSCRIBED"
  | "TIMED_OUT"
  | "CLOSED"
  | "CHANNEL_ERROR";

export function subscribeToCalendarChanges(
  userId: string,
  onChange: () => void,
  onStatus: (status: CalendarRealtimeStatus) => void,
): RealtimeChannel {
  return supabase
    .channel(`calendar-changes:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "event_sync_changes",
        filter: `user_id=eq.${userId}`,
      },
      () => onChange(),
    )
    .subscribe((status) => onStatus(status));
}

export function removeCalendarChangesSubscription(channel: RealtimeChannel) {
  return supabase.removeChannel(channel);
}

export async function listCalendarEvents(): Promise<{
  events: CalendarEvent[];
  profileNamesUnavailable: boolean;
}> {
  const { data: eventData, error: eventError } = await supabase
    .from("events")
    .select("id, owner_id, title, description, category, event_date, start_time, end_time, status, version, reminder_enabled, reminder_value, reminder_unit")
    .eq("status", "confirmed")
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true });

  if (eventError) throw eventError;

  const eventRows = (eventData ?? []) as EventRow[];
  if (eventRows.length === 0) return { events: [], profileNamesUnavailable: false };

  const eventIds = eventRows.map((event) => event.id);
  const eventOwnerIds = new Map(eventRows.map((event) => [event.id, event.owner_id]));
  const { data: participantData, error: participantError } = await supabase
    .from("event_participants")
    .select("event_id, user_id")
    .in("event_id", eventIds);

  if (participantError) throw participantError;

  const participantRows = (participantData ?? []) as ParticipantRow[];
  const participantKeys = new Set(
    participantRows.map(({ event_id, user_id }) => getParticipantKey(event_id, user_id)),
  );
  let organizerNames = new Map<string, string>();
  let participantNames = new Map<string, string>();
  let profileNamesUnavailable = false;

  try {
    const { data: organizerData, error: organizerError } = await supabase.rpc(
      "list_event_organizers",
      { p_event_ids: eventIds },
    );
    if (organizerError) throw organizerError;
    if (!Array.isArray(organizerData)) {
      throw new Error("El servidor devolvió una lista de organizadores no válida.");
    }

    organizerNames = new Map((organizerData as unknown[]).map((row) => {
      if (!row || typeof row !== "object") {
        throw new Error("El servidor devolvió un organizador no válido.");
      }

      const organizer = row as Partial<EventOrganizerRow>;
      if (
        typeof organizer.event_id !== "string"
        || typeof organizer.owner_id !== "string"
        || eventOwnerIds.get(organizer.event_id) !== organizer.owner_id
        || typeof organizer.full_name !== "string"
      ) {
        throw new Error("El servidor devolvió un organizador no válido.");
      }

      return [organizer.owner_id, organizer.full_name];
    }));
  } catch {
    profileNamesUnavailable = true;
  }

  try {
    const { data: participantNameData, error: participantNameError } = await supabase.rpc(
      "list_event_participants",
      { p_event_ids: eventIds },
    );
    if (participantNameError) throw participantNameError;
    if (!Array.isArray(participantNameData)) {
      throw new Error("El servidor devolvió una lista de participantes no válida.");
    }

    participantNames = new Map((participantNameData as unknown[]).map((row) => {
      if (!row || typeof row !== "object") {
        throw new Error("El servidor devolvió un participante no válido.");
      }

      const participant = row as Partial<EventParticipantNameRow>;
      const key = typeof participant.event_id === "string" && typeof participant.user_id === "string"
        ? getParticipantKey(participant.event_id, participant.user_id)
        : "";
      if (
        !key
        || !participantKeys.has(key)
        || typeof participant.full_name !== "string"
        || !participant.full_name.trim()
      ) {
        throw new Error("El servidor devolvió un participante no válido.");
      }

      return [key, participant.full_name.trim()];
    }));
  } catch {
    profileNamesUnavailable = true;
  }

  if (eventRows.some((event) => !organizerNames.has(event.owner_id))) {
    profileNamesUnavailable = true;
  }
  if (participantRows.some(({ event_id, user_id }) => (
    !participantNames.has(getParticipantKey(event_id, user_id))
  ))) {
    profileNamesUnavailable = true;
  }

  const participantsByEvent = new Map<string, string[]>();
  participantRows.forEach(({ event_id, user_id }) => {
    participantsByEvent.set(event_id, [...(participantsByEvent.get(event_id) ?? []), user_id]);
  });

  const events = eventRows.map((event) => ({
    id: event.id,
    version: Number(event.version),
    title: event.title,
    description: event.description,
    category: event.category,
    date: event.event_date,
    startTime: normalizeTime(event.start_time),
    endTime: normalizeTime(event.end_time),
    reminderEnabled: event.reminder_enabled,
    reminderValue: event.reminder_value ?? 0,
    reminderUnit: event.reminder_unit ?? "minutes",
    createdBy: {
      id: event.owner_id,
      name: organizerNames.get(event.owner_id) ?? "Nombre no disponible",
    },
    assignedWorkers: (participantsByEvent.get(event.id) ?? []).map((id) => {
      const name = participantNames.get(getParticipantKey(event.id, id)) ?? "";
      return {
        id,
        name: name || "Nombre no disponible",
      };
    }),
  }));
  return { events, profileNamesUnavailable };
}

export async function listAssignableWorkers(currentUserId: string): Promise<AssignableWorker[]> {
  const { data, error } = await supabase.rpc("list_assignable_event_users");

  if (error) throw error;
  if (!Array.isArray(data)) {
    throw new Error("El servidor devolvió una lista de usuarios no válida.");
  }

  return data.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") {
      throw new Error("El servidor devolvió un usuario no válido.");
    }

    const profile = row as Partial<AssignableProfileRow>;
    if (
      typeof profile.id !== "string"
      || profile.id === currentUserId
      || typeof profile.full_name !== "string"
      || (profile.role !== "administrador" && profile.role !== "empleado")
    ) {
      throw new Error("El servidor devolvió un usuario no válido.");
    }

    return [{
      id: profile.id,
      name: profile.full_name,
      role: profile.role,
    }];
  });
}

async function runEventOperation(
  operation: "save_event" | "cancel_event",
  parameters: Record<string, unknown>,
): Promise<CalendarOperationResult> {
  const { data, error } = await supabase.rpc(operation, parameters);
  if (error) throw error;
  if (!isRpcResponse(data)) {
    throw new Error("El servidor devolvió una respuesta de evento no válida.");
  }

  if (data.status === "confirmed") {
    if (typeof data.event_id !== "string" || typeof data.version !== "number") {
      throw new Error("El servidor confirmó una respuesta incompleta para el evento.");
    }
    return { status: "confirmed", eventId: data.event_id, version: data.version };
  }

  return {
    status: data.status,
    code: data.code ?? "unknown",
  };
}

export function saveCalendarEvent(input: SaveCalendarEventInput) {
  return runEventOperation("save_event", {
    p_operation_id: input.operationId,
    p_event_id: input.eventId,
    p_expected_version: input.expectedVersion,
    p_title: input.title,
    p_description: input.description,
    p_category: input.category,
    p_event_date: input.date,
    p_start_time: input.startTime,
    p_end_time: input.endTime,
    p_participant_ids: input.participantIds,
    p_reminder_enabled: input.reminderEnabled,
    p_reminder_value: input.reminderValue,
    p_reminder_unit: input.reminderUnit,
    p_resolves_operation_id: input.resolvesOperationId ?? null,
  });
}

export function cancelCalendarEvent(
  operationId: string,
  eventId: string,
  expectedVersion: number,
  resolvesOperationId: string | null = null,
) {
  return runEventOperation("cancel_event", {
    p_operation_id: operationId,
    p_event_id: eventId,
    p_expected_version: expectedVersion,
    p_resolves_operation_id: resolvesOperationId,
  });
}

export function getCalendarOperationMessage(result: CalendarOperationResult) {
  if (result.status === "confirmed") return "";
  if (result.code === "schedule_unavailable") {
    return "Conflicto de horario. Revisa el evento y vuelve a intentarlo.";
  }
  if (result.code === "version_conflict") {
    return "El evento cambió en otra sesión. Actualiza la agenda e inténtalo nuevamente.";
  }
  if (result.code === "not_authorized") {
    return "Tu permiso para asignar trabajadores no está habilitado en tu perfil. Contacta a un administrador.";
  }
  if (result.code === "operation_id_reused") {
    return "No se pudo confirmar la operación. Inténtalo nuevamente.";
  }
  if (result.code === "event_not_active") {
    return "El evento ya no está disponible. Actualiza la agenda.";
  }
  return "No se pudo confirmar el cambio del evento. Revisa los datos e inténtalo nuevamente.";
}
