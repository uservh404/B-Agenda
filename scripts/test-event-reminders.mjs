import assert from "node:assert/strict";
import { createEventReminderSchedules } from "../src/services/event-reminders.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const unrelatedUserId = "00000000-0000-4000-8000-000000000004";
const start = new Date(2026, 10, 4, 10, 0, 0, 0);
const event = {
  id: "00000000-0000-4000-8000-000000000003",
  version: 1,
  title: "Reunión de personal",
  description: "",
  category: "",
  date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`,
  startTime: "10:00",
  endTime: "11:00",
  reminderEnabled: true,
  reminderValue: 15,
  reminderUnit: "minutes",
  createdBy: { id: otherUserId, name: "Organizador" },
  assignedWorkers: [{ id: userId, name: "Trabajador" }],
};

const minutesReminder = createEventReminderSchedules(
  [event],
  userId,
  start.getTime() - 3_600_000,
)[0];
assert.equal(minutesReminder.dueAtMs, new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 45).getTime());
assert.match(minutesReminder.body, /15 minutos/);
assert.match(minutesReminder.body, /10:00/);

const hourReminder = createEventReminderSchedules(
  [{ ...event, reminderValue: 1, reminderUnit: "hours" }],
  userId,
  start.getTime() - 3_600_000,
)[0];
assert.equal(hourReminder.dueAtMs, new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0).getTime());
assert.match(hourReminder.body, /1 hora/);

const dayReminder = createEventReminderSchedules(
  [{ ...event, reminderValue: 2, reminderUnit: "days" }],
  userId,
  start.getTime() - 14 * 24 * 3_600_000,
)[0];
assert.equal(dayReminder.dueAtMs, new Date(start.getFullYear(), start.getMonth(), start.getDate() - 2, 10, 0).getTime());
assert.match(dayReminder.body, /2 días/);
assert.doesNotMatch(dayReminder.body, /a las/);

const weekReminder = createEventReminderSchedules(
  [{ ...event, reminderValue: 1, reminderUnit: "weeks" }],
  userId,
  start.getTime() - 14 * 24 * 3_600_000,
)[0];
assert.equal(weekReminder.dueAtMs, new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7, 10, 0).getTime());
assert.match(weekReminder.body, /1 semana/);
assert.doesNotMatch(weekReminder.body, /a las/);

const startReminder = createEventReminderSchedules(
  [{ ...event, reminderEnabled: false }],
  userId,
  start.getTime() + 30_000,
)[0];
assert.equal(startReminder.dueAtMs, start.getTime());
assert.match(startReminder.body, /comienza ahora/);

assert.equal(createEventReminderSchedules([event], otherUserId, start.getTime() - 3_600_000).length, 1);
assert.equal(createEventReminderSchedules([event], unrelatedUserId, start.getTime() - 3_600_000).length, 0);
assert.equal(createEventReminderSchedules(
  [event],
  userId,
  start.getTime() - 3_600_000,
  new Set([event.id]),
).length, 0);

const rescheduledReminder = createEventReminderSchedules(
  [{ ...event, date: event.date.replace("-04", "-05") }],
  userId,
  start.getTime() - 3_600_000,
)[0];
assert.notEqual(rescheduledReminder.scheduleKey, minutesReminder.scheduleKey);
assert.notEqual(rescheduledReminder.dueAtMs, minutesReminder.dueAtMs);

console.log("Event reminder scheduling cases passed.");
