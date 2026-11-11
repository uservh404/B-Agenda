export type ReminderUnit = "minutes" | "hours" | "days" | "weeks";

export interface CalendarPerson {
  id: string;
  name: string;
}

export interface CalendarEvent {
  id: string;
  version: number;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  reminderEnabled: boolean;
  reminderValue: number;
  reminderUnit: ReminderUnit;
  createdBy: CalendarPerson;
  assignedWorkers: CalendarPerson[];
  category: string;
  date: string;
}

export interface AssignableWorker extends CalendarPerson {
  role: "administrador" | "empleado";
}

export interface SaveCalendarEventInput {
  operationId: string;
  eventId: string;
  expectedVersion: number;
  title: string;
  description: string;
  category: string;
  date: string;
  startTime: string;
  endTime: string;
  participantIds: string[] | null;
  reminderEnabled: boolean;
  reminderValue: number | null;
  reminderUnit: ReminderUnit | null;
  resolvesOperationId?: string | null;
}

export type CalendarOperationResult =
  | { status: "confirmed"; eventId: string; version: number }
  | { status: "conflict" | "rejected"; code: string };
