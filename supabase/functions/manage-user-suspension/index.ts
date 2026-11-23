import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusBatchLimit = 40;
const suspensionDuration = "876000h";

class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isValidUserIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= statusBatchLimit
    && value.every((userId) => typeof userId === "string" && userIdPattern.test(userId))
    && new Set(value).size === value.length;
}

function getServiceKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed: unknown = JSON.parse(secretKeys);
    if (isRecord(parsed) && typeof parsed.default === "string") return parsed.default;
  }
  return "";
}

function isSuspended(user: User) {
  if (!user.banned_until) return false;
  const bannedUntil = Date.parse(user.banned_until);
  if (!Number.isFinite(bannedUntil)) {
    throw new RequestError("service_unavailable", 503);
  }
  return bannedUntil > Date.now();
}

async function assertActorIsActive(admin: SupabaseClient, actorId: string) {
  let actor: User;
  try {
    const { data, error } = await admin.auth.admin.getUserById(actorId);
    if (error || !data.user) {
      console.error("Could not verify the administrator's Auth status.", {
        code: error?.code ?? "user_not_found",
      });
      throw new RequestError("service_unavailable", 503);
    }
    actor = data.user;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    console.error("Could not verify the administrator's Auth status.", {
      code: error instanceof Error ? error.name : "auth_lookup_failed",
    });
    throw new RequestError("service_unavailable", 503);
  }

  if (isSuspended(actor)) {
    throw new RequestError("account_suspended", 403);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapValue: (value: T) => Promise<R>,
) {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await mapValue(values[index]);
    }
  }));
  return result;
}

async function getProfileRole(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Could not verify a profile role for account suspension.", { code: error.code });
    throw new RequestError("service_unavailable", 503);
  }
  if (!data) throw new RequestError("user_not_found", 404);
  return data.role;
}

async function getSuspensionList(admin: SupabaseClient, userIds: unknown) {
  if (!isValidUserIdList(userIds)) throw new RequestError("invalid_request", 400);
  if (userIds.length === 0) return [];

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .in("id", userIds);
  if (profileError) {
    console.error("Could not verify profiles for account suspension status.", { code: profileError.code });
    throw new RequestError("service_unavailable", 503);
  }
  if (!profiles || profiles.length !== userIds.length) {
    throw new RequestError("user_not_found", 404);
  }

  return await mapWithConcurrency(userIds, 8, async (userId) => {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data.user) {
      console.error("Could not read an Auth suspension status.", { code: error?.code ?? "user_not_found" });
      throw new RequestError(error ? "service_unavailable" : "user_not_found", error ? 503 : 404);
    }
    return { userId, suspended: isSuspended(data.user) };
  });
}

async function updateSuspension(
  admin: SupabaseClient,
  userId: string,
  action: "suspend" | "reactivate",
) {
  const { data, error } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: action === "suspend" ? suspensionDuration : "none",
  });
  if (error || !data.user) {
    console.error("Could not update an Auth suspension.", { code: error?.code ?? "user_not_found" });
    throw new RequestError(error ? "service_unavailable" : "user_not_found", error ? 503 : 404);
  }
  return { userId, suspended: isSuspended(data.user) };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, code: "invalid_request" }, 405);
  }

  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("apikey");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  let serviceKey = "";
  try {
    serviceKey = getServiceKey();
  } catch (error) {
    console.error("Could not read the Supabase service key configuration.", error);
  }
  if (!supabaseUrl || !apiKey || !serviceKey) {
    console.error("Supabase account-suspension credentials are not configured.");
    return jsonResponse({ ok: false, code: "service_unavailable" }, 503);
  }
  if (!authorization?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, code: "not_authorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return jsonResponse({ ok: false, code: "invalid_request" }, 413);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return jsonResponse({ ok: false, code: "invalid_request" }, 400);
    body = parsed;
  } catch {
    return jsonResponse({ ok: false, code: "invalid_request" }, 400);
  }

  try {
    const authClient = createClient(supabaseUrl, apiKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const token = authorization.slice("Bearer ".length);
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) throw new RequestError("not_authorized", 401);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await assertActorIsActive(admin, authData.user.id);
    const actorRole = await getProfileRole(admin, authData.user.id);
    if (actorRole !== "administrador") throw new RequestError("not_authorized", 403);

    if (body.action === "list") {
      const statuses = await getSuspensionList(admin, body.userIds);
      return jsonResponse({ ok: true, statuses });
    }

    if (
      (body.action !== "suspend" && body.action !== "reactivate")
      || typeof body.userId !== "string"
      || !userIdPattern.test(body.userId)
    ) {
      throw new RequestError("invalid_request", 400);
    }
    if (body.userId === authData.user.id) throw new RequestError("cannot_modify_self", 403);

    const targetRole = await getProfileRole(admin, body.userId);
    if (targetRole !== "empleado") throw new RequestError("employees_only", 403);

    const result = await updateSuspension(admin, body.userId, body.action);
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse({ ok: false, code: error.code }, error.status);
    }
    console.error("Account suspension request failed.", error);
    return jsonResponse({ ok: false, code: "service_unavailable" }, 503);
  }
});
