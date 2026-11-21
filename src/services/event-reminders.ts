import type { CalendarEvent, ReminderUnit } from "../types/calendar";

export interface ScheduledEventReminder {
  eventId: string;
  scheduleKey: string;
  title: string;
  body: string;
  dueAtMs: number;
  startAtMs: number;
  expiresAtMs: number;
}

const UNIT_LABELS: Record<ReminderUnit, [string, string]> = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["día", "días"],
  weeks: ["semana", "semanas"],
};

function getLocalStart(event: CalendarEvent): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date);
  const time = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(event.startTime);
  if (!date || !time) return null;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const start = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    Number.isNaN(start.getTime())
    || start.getFullYear() !== year
    || start.getMonth() !== month - 1
    || start.getDate() !== day
  ) {
    return null;
  }
  return start;
}

function getReminderDate(start: Date, value: number, unit: ReminderUnit): Date {
  const due = new Date(start);
  if (unit === "minutes") {
    due.setTime(due.getTime() - value * 60_000);
  } else if (unit === "hours") {
    due.setTime(due.getTime() - value * 3_600_000);
  } else if (unit === "days") {
    due.setDate(due.getDate() - value);
  } else {
    due.setDate(due.getDate() - value * 7);
  }
  return due;
}

function formatStartTime(start: Date) {
  return new Intl.DateTimeFormat("es-MX", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);
}

function formatReminderBody(event: CalendarEvent, start: Date, hasAnticipation: boolean) {
  const title = event.title.trim();
  if (!hasAnticipation) return `¡El evento "${title}" comienza ahora!`;

  const [singular, plural] = UNIT_LABELS[event.reminderUnit];
  const unit = event.reminderValue === 1 ? singular : plural;
  const time = event.reminderUnit === "minutes" || event.reminderUnit === "hours"
    ? `, a las ${formatStartTime(start)}`
    : "";
  return `El evento "${title}" comienza dentro de ${event.reminderValue} ${unit}${time}.`;
}

export function createEventReminderSchedules(
  events: CalendarEvent[],
  userId: string,
  nowMs = Date.now(),
  excludedEventIds: ReadonlySet<string> = new Set(),
): ScheduledEventReminder[] {
  const schedules: ScheduledEventReminder[] = [];
  const seenEventIds = new Set<string>();

  for (const event of events) {
    if (event.reminderMode === "off") continue;
    if (
      excludedEventIds.has(event.id)
      || seenEventIds.has(event.id)
      || (event.createdBy.id !== userId
        && !event.assignedWorkers.some((worker) => worker.id === userId))
      || !event.title.trim()
    ) {
      continue;
    }
    seenEventIds.add(event.id);

    const start = getLocalStart(event);
    if (!start) continue;

    const hasAnticipation = event.reminderMode === "start"
      ? false
      : event.reminderMode === "anticipation"
        ? Number.isInteger(event.reminderValue)
          && event.reminderValue > 0
          && Object.hasOwn(UNIT_LABELS, event.reminderUnit)
        : event.reminderEnabled
      && Number.isInteger(event.reminderValue)
      && event.reminderValue > 0
      && Object.hasOwn(UNIT_LABELS, event.reminderUnit);
    if (event.reminderMode === "anticipation" && !hasAnticipation) continue;
    const due = hasAnticipation
      ? getReminderDate(start, event.reminderValue, event.reminderUnit)
      : start;
    const startAtMs = start.getTime();
    const dueAtMs = due.getTime();
    const expiresAtMs = hasAnticipation ? startAtMs - 1 : startAtMs + 60_000;
    if (expiresAtMs < nowMs) continue;

    const anticipationKey = hasAnticipation
      ? `${event.reminderValue}-${event.reminderUnit}`
      : "start";
    schedules.push({
      eventId: event.id,
      scheduleKey: `${event.id}:${startAtMs}:${anticipationKey}`,
      title: event.title.trim(),
      body: formatReminderBody(event, start, hasAnticipation),
      dueAtMs,
      startAtMs,
      expiresAtMs,
    });
  }

  return schedules;
}
