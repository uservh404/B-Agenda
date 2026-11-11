import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const configPath = resolve(process.cwd(), ".env.calendar-authz.local");

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function requireValue(config, name) {
  const value = config[name]?.trim();
  if (!value) throw new Error(`Falta configurar ${name} en .env.calendar-authz.local.`);
  return value;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAnonOrPublishableKey(value) {
  if (value.startsWith("sb_publishable_")) return true;
  const payload = value.split(".")[1];
  if (!payload) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded.role === "anon";
  } catch {
    return false;
  }
}

function getFutureTestSchedule() {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 45);
  const dateKey = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const startHour = 8 + Math.floor(Math.random() * 10);
  const startMinute = Math.floor(Math.random() * 4) * 15;
  const endMinute = startMinute + 30;
  const endHour = startHour + Math.floor(endMinute / 60);
  const normalizedEndMinute = endMinute % 60;

  return {
    date: dateKey,
    startTime: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00`,
    endTime: `${String(endHour).padStart(2, "0")}:${String(normalizedEndMinute).padStart(2, "0")}:00`,
  };
}

async function main() {
  let contents;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    throw new Error(
      "No se encontró .env.calendar-authz.local. Copia el archivo de ejemplo, completa la configuración privada y vuelve a intentar.",
    );
  }

  const config = parseEnvFile(contents);
  const supabaseUrl = requireValue(config, "AUTHZ_TEST_SUPABASE_URL");
  const expectedProjectRef = requireValue(config, "AUTHZ_TEST_PROJECT_REF");
  const anonKey = requireValue(config, "AUTHZ_TEST_SUPABASE_ANON_KEY");
  const employeeEmail = requireValue(config, "AUTHZ_TEST_EMPLOYEE_EMAIL");
  const employeePassword = requireValue(config, "AUTHZ_TEST_EMPLOYEE_PASSWORD");
  const expectedEmployeeId = requireValue(config, "AUTHZ_TEST_EMPLOYEE_ID");
  const participantId = requireValue(config, "AUTHZ_TEST_PARTICIPANT_ID");
  const confirmation = requireValue(config, "AUTHZ_TEST_CONFIRM_NON_PRODUCTION");

  if (confirmation !== "I_CONFIRM_THIS_IS_A_NON_PRODUCTION_TEST_PROJECT") {
    throw new Error("La confirmación del proyecto de pruebas no coincide; no se realizará ninguna conexión.");
  }
  if (!isAnonOrPublishableKey(anonKey)) {
    throw new Error("La clave configurada no parece una clave anon/publishable. No se permiten claves administrativas.");
  }
  if (!isUuid(expectedEmployeeId) || !isUuid(participantId) || expectedEmployeeId === participantId) {
    throw new Error("Configura UUIDs válidos y distintos para el empleado y el participante.");
  }

  const url = new URL(supabaseUrl);
  if (
    url.protocol !== "https:"
    || url.hostname !== `${expectedProjectRef}.supabase.co`
    || url.username
    || url.password
  ) {
    throw new Error("La URL no coincide exactamente con el ref del proyecto de pruebas configurado.");
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: employeeEmail,
    password: employeePassword,
  });
  if (authError) throw new Error(`No se pudo iniciar sesión con el empleado de prueba: ${authError.message}`);
  if (authData.user?.id !== expectedEmployeeId) {
    throw new Error("El usuario autenticado no coincide con AUTHZ_TEST_EMPLOYEE_ID.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, can_assign_events")
    .eq("id", expectedEmployeeId)
    .single();
  if (profileError) throw new Error(`No se pudo verificar el perfil propio: ${profileError.message}`);
  if (profile.role !== "empleado" || profile.can_assign_events !== false) {
    throw new Error("La prueba requiere un empleado cuyo can_assign_events sea false.");
  }

  const eventId = randomUUID();
  const operationId = randomUUID();
  const schedule = getFutureTestSchedule();
  const { data: response, error: rpcError } = await supabase.rpc("save_event", {
    p_operation_id: operationId,
    p_event_id: eventId,
    p_expected_version: 0,
    p_title: `Prueba temporal de autorización ${operationId.slice(0, 8)}`,
    p_description: "Evento temporal para comprobar el rechazo de asignación no autorizada.",
    p_category: "Prueba de autorización",
    p_event_date: schedule.date,
    p_start_time: schedule.startTime,
    p_end_time: schedule.endTime,
    p_participant_ids: [participantId],
    p_reminder_enabled: false,
    p_reminder_value: null,
    p_reminder_unit: null,
    p_resolves_operation_id: null,
  });

  const rejectedAsUnauthorized = !rpcError
    && response?.status === "rejected"
    && response?.code === "not_authorized";
  const raisedUnauthorized = Boolean(
    rpcError
    && rpcError.message.toLowerCase().includes("not_authorized"),
  );
  if (!rejectedAsUnauthorized && !raisedUnauthorized) {
    console.error("FALLO: Supabase no confirmó el rechazo de autorización esperado.");
    console.error("Respuesta RPC:", response ?? "(sin respuesta)");
    console.error("Error RPC:", rpcError?.message ?? "(sin error)");
    console.error(`UUID temporal del evento: ${eventId}`);
    console.error(`UUID de operación: ${operationId}`);
    console.error("No se intentó eliminar ni cancelar nada automáticamente.");
    process.exitCode = 1;
    return;
  }

  const { data: persistedEvents, error: eventCheckError } = await supabase
    .from("events")
    .select("id, owner_id, scope, status")
    .eq("id", eventId);
  if (eventCheckError) {
    throw new Error(`Se confirmó el rechazo, pero no se pudo comprobar el evento con la sesión autenticada: ${eventCheckError.message}`);
  }
  if (persistedEvents?.length) {
    console.error("FALLO: se encontró el evento temporal aunque la operación devolvió rechazo.");
    console.error(`UUID temporal del evento: ${eventId}`);
    console.error(`UUID de operación: ${operationId}`);
    process.exitCode = 1;
    return;
  }

  console.log("OK: save_event rechazó la asignación con not_authorized.");
  console.log("OK: la sesión del empleado no encontró ningún evento creado para ese UUID.");
  console.log("La tabla event_reservations no se consulta con permisos de empleado; verifica también sus filas con la consulta SQL de solo lectura indicada en la guía.");
  console.log(`UUID temporal del evento: ${eventId}`);
  console.log(`UUID de operación: ${operationId}`);

  await supabase.auth.signOut();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Falló la prueba de autorización.");
  process.exitCode = 1;
});
