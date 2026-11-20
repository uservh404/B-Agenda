import { supabase } from "../lib/supabaseClient";

const STATUS_BATCH_SIZE = 40;

export type AccountSuspensionAction = "suspend" | "reactivate";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getErrorMessage(code: string) {
  switch (code) {
    case "not_authorized":
      return "No tienes autorización para realizar esta acción.";
    case "cannot_modify_self":
      return "No puedes suspender ni reactivar tu propia cuenta.";
    case "employees_only":
      return "Esta acción solo está disponible para cuentas de empleados.";
    case "user_not_found":
      return "No se encontró la cuenta seleccionada.";
    case "invalid_request":
      return "La solicitud no es válida. Actualiza la lista e inténtalo nuevamente.";
    case "service_unavailable":
    default:
      return "No se pudo consultar o actualizar el estado de la cuenta. Inténtalo nuevamente.";
  }
}

async function getFunctionErrorCode(error: unknown): Promise<string> {
  if (isRecord(error) && error.context instanceof Response) {
    try {
      const body: unknown = await error.context.clone().json();
      if (isRecord(body) && typeof body.code === "string") return body.code;
    } catch {
      return "service_unavailable";
    }
  }
  return "service_unavailable";
}

async function invokeSuspensionFunction(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke<unknown>(
    "manage-user-suspension",
    { body },
  );
  if (error) {
    throw new Error(getErrorMessage(await getFunctionErrorCode(error)));
  }
  if (!isRecord(data) || data.ok !== true) {
    throw new Error("El servidor devolvió una respuesta inválida al gestionar la cuenta.");
  }
  return data;
}

export async function getAccountSuspensionStatuses(userIds: string[]) {
  const statuses: Record<string, boolean> = {};

  for (let offset = 0; offset < userIds.length; offset += STATUS_BATCH_SIZE) {
    const batch = userIds.slice(offset, offset + STATUS_BATCH_SIZE);
    const data = await invokeSuspensionFunction({
      action: "list",
      userIds: batch,
    });
    if (!Array.isArray(data.statuses)) {
      throw new Error("El servidor devolvió una lista inválida de estados de cuenta.");
    }

    for (const value of data.statuses) {
      if (
        !isRecord(value)
        || typeof value.userId !== "string"
        || typeof value.suspended !== "boolean"
        || !batch.includes(value.userId)
        || Object.hasOwn(statuses, value.userId)
      ) {
        throw new Error("El servidor devolvió una lista inválida de estados de cuenta.");
      }
      statuses[value.userId] = value.suspended;
    }

    if (batch.some((userId) => !Object.hasOwn(statuses, userId))) {
      throw new Error("No se pudo comprobar el estado de todas las cuentas.");
    }
  }

  return statuses;
}

export async function setAccountSuspension(
  userId: string,
  action: AccountSuspensionAction,
) {
  const data = await invokeSuspensionFunction({ action, userId });
  const suspended = action === "suspend";
  if (data.userId !== userId || data.suspended !== suspended) {
    throw new Error("El servidor no confirmó el cambio de estado de la cuenta.");
  }
  return suspended;
}
