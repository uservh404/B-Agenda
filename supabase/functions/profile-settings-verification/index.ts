import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@^9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const digestPattern = /^[0-9a-f]{64}$/;

interface ProfileSettingsOperation {
  fullName: string;
  phone: string | null;
  updatePhone: boolean;
  updateProfile: boolean;
  newEmail: string | null;
  operationDigest: string;
}

interface ProfileRow {
  full_name: string;
  phone: string | null;
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

function getHmacSecret() {
  const secret = Deno.env.get("PROFILE_VERIFICATION_SECRET") ?? "";
  if (new TextEncoder().encode(secret).length < 32) {
    throw new Error("PROFILE_VERIFICATION_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateCode() {
  const range = 0x100000000;
  const limit = Math.floor(range / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return String(value[0] % 1_000_000).padStart(6, "0");
}

function maskEmail(email: string) {
  const separator = email.lastIndexOf("@");
  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = localPart.length > 1 ? localPart[0] : "";
  return `${visible}***@${domain}`;
}

function normalizePhone(value: string) {
  if (!/^[+\d\s().-]+$/.test(value.trim())) return null;
  const compact = value.trim().replace(/[\s().-]/g, "");
  const national = compact.startsWith("+52") ? compact.slice(3) : compact;
  return /^\d{10}$/.test(national) ? `+52${national}` : null;
}

function validateFullName(value: string) {
  return value.length >= 2
    && value.length <= 100
    && /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(value);
}

async function getAuthorizedUser(request: Request, supabaseUrl: string) {
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("apikey");
  if (!authorization?.startsWith("Bearer ") || !apiKey) return null;

  const client = createClient(supabaseUrl, apiKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

async function getCurrentProfile(admin: SupabaseClient, userId: string): Promise<ProfileRow> {
  const { data, error } = await admin
    .from("profiles")
    .select("full_name, phone")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Could not read the authenticated user's profile.", { code: error.code });
    throw new Error("profile_unavailable");
  }
  if (
    !data
    || typeof data.full_name !== "string"
    || (data.phone !== null && typeof data.phone !== "string")
  ) {
    throw new Error("profile_unavailable");
  }
  return { full_name: data.full_name, phone: data.phone };
}

async function normalizeOperation(
  input: unknown,
  user: User,
  currentProfile: ProfileRow,
  secret: string,
): Promise<ProfileSettingsOperation | null> {
  if (!isRecord(input)) return null;
  if (typeof input.fullName !== "string" || typeof input.updatePhone !== "boolean") return null;
  if (input.phone !== null && typeof input.phone !== "string") return null;
  if (input.newEmail !== null && typeof input.newEmail !== "string") return null;
  if (!user.email || !user.email_confirmed_at) throw new Error("email_not_verified");

  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  if (!validateFullName(fullName)) return null;

  const requestedPhone = input.updatePhone ? input.phone as string | null : null;
  let phone: string | null = null;
  if (input.updatePhone && requestedPhone?.trim()) {
    phone = normalizePhone(requestedPhone);
    if (!phone) return null;
  }

  const updatePhone = input.updatePhone && phone !== currentProfile.phone;
  const updateProfile = fullName !== currentProfile.full_name || updatePhone;

  let newEmail: string | null = null;
  if (typeof input.newEmail === "string") {
    const candidateEmail = input.newEmail.trim().toLowerCase();
    if (!emailPattern.test(candidateEmail) || candidateEmail.length > 254) return null;
    if (candidateEmail !== user.email.trim().toLowerCase()) newEmail = candidateEmail;
  }
  if (user.new_email && newEmail) throw new Error("email_change_pending");

  if (!updateProfile && !newEmail) throw new Error("no_changes");

  const operationValue = JSON.stringify({
    userId: user.id,
    currentEmail: user.email.trim().toLowerCase(),
    fullName,
    phone: updatePhone ? phone : null,
    updatePhone,
    updateProfile,
    newEmail,
  });
  const operationDigest = await hmacHex(secret, `profile-settings:v1:${operationValue}`);

  return {
    fullName,
    phone: updatePhone ? phone : null,
    updatePhone,
    updateProfile,
    newEmail,
    operationDigest,
  };
}

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return "service_unavailable";
  switch (error.message) {
    case "email_not_verified":
    case "email_change_pending":
    case "email_delivery_failed":
    case "no_changes":
      return error.message;
    default:
      return "service_unavailable";
  }
}

async function sendVerificationEmail(to: string, code: string) {
  const username = Deno.env.get("GMAIL_SMTP_USER")?.trim();
  const password = Deno.env.get("GMAIL_SMTP_APP_PASSWORD");
  if (!username || !password) {
    console.error("Gmail SMTP credentials are not configured.");
    throw new Error("email_delivery_failed");
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: username, pass: password },
    tls: {
      servername: "smtp.gmail.com",
      rejectUnauthorized: true,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    const result = await transporter.sendMail({
      from: { name: "AgendaJuventud", address: username },
      to,
      subject: "Código de verificación de AgendaJuventud",
      text: `Tu código de verificación es ${code}. Vence en 5 minutos. Si no solicitaste este cambio, ignora este mensaje.`,
      html: `<p>Usa este código para verificar tu identidad en AgendaJuventud:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>El código vence en 5 minutos. Si no solicitaste este cambio, ignora este mensaje.</p>`,
    });

    const accepted = Array.isArray(result.accepted) ? result.accepted : [];
    const rejected = Array.isArray(result.rejected) ? result.rejected : [];
    const recipientAccepted = accepted.some(
      (recipient: unknown) => String(recipient).toLowerCase() === to.trim().toLowerCase(),
    );
    if (!recipientAccepted || rejected.length > 0) {
      throw new Error("smtp_recipient_not_accepted");
    }
  } catch (error) {
    console.error("Gmail SMTP could not send the identity verification email.", {
      code: isRecord(error) && typeof error.code === "string" ? error.code : "smtp_send_failed",
      responseCode: isRecord(error) && typeof error.responseCode === "number"
        ? error.responseCode
        : undefined,
    });
    throw new Error("email_delivery_failed", { cause: error });
  } finally {
    transporter.close();
  }
}

async function issueChallenge(
  admin: SupabaseClient,
  user: User,
  operation: ProfileSettingsOperation,
  secret: string,
) {
  const challengeId = crypto.randomUUID();
  const code = generateCode();
  const codeDigest = await hmacHex(secret, `profile-code:v1:${user.id}:${challengeId}:${code}`);
  const { data, error } = await admin.rpc("reserve_profile_settings_verification_v1", {
    p_challenge_id: challengeId,
    p_user_id: user.id,
    p_operation_digest: operation.operationDigest,
    p_code_digest: codeDigest,
  });

  if (error) {
    console.error("Could not reserve an identity-verification challenge.", { code: error.code });
    throw new Error("service_unavailable");
  }

  const reservation = Array.isArray(data) ? data[0] : null;
  if (!reservation) throw new Error("service_unavailable");
  if (reservation.status === "rate_limited" || reservation.status === "cooldown") {
    const retryAt = typeof reservation.retry_at === "string" ? Date.parse(reservation.retry_at) : NaN;
    if (!Number.isFinite(retryAt)) {
      console.error("The verification policy returned a wait limit without a retry timestamp.");
      throw new Error("service_unavailable");
    }
    return {
      status: reservation.status === "cooldown" ? "resend_cooldown" as const : "rate_limited" as const,
      retryAt: new Date(retryAt).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
    };
  }
  if (reservation.status !== "reserved" || reservation.challenge_id !== challengeId) {
    throw new Error("service_unavailable");
  }

  try {
    await sendVerificationEmail(user.email!, code);
  } catch (error) {
    const { data: cancelled, error: cancelError } = await admin.rpc("cancel_profile_settings_verification_v1", {
      p_challenge_id: challengeId,
      p_user_id: user.id,
    });
    if (cancelError || cancelled !== true) {
      console.error("Could not invalidate a challenge after email delivery failed.", {
        code: cancelError?.code ?? "challenge_not_cancelled",
      });
    }
    throw error;
  }

  let activated: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data: activationData, error: activationError } = await admin.rpc(
      "activate_profile_settings_verification_v1",
      {
        p_challenge_id: challengeId,
        p_user_id: user.id,
      },
    );
    if (!activationError) {
      activated = Array.isArray(activationData) && isRecord(activationData[0])
        ? activationData[0]
        : null;
      break;
    }
    console.error("Could not activate a delivered identity-verification challenge.", {
      code: activationError.code,
      attempt: attempt + 1,
    });
  }

  if (
    !activated
    || activated.status !== "issued"
    || activated.challenge_id !== challengeId
    || typeof activated.expires_at !== "string"
    || typeof activated.resend_at !== "string"
    || !Number.isFinite(Date.parse(activated.expires_at))
    || !Number.isFinite(Date.parse(activated.resend_at))
  ) {
    throw new Error("service_unavailable");
  }

  return {
    status: "issued" as const,
    challenge: {
      id: challengeId,
      maskedEmail: maskEmail(user.email!),
      expiresAt: activated.expires_at,
      resendAvailableAt: activated.resend_at,
    },
  };
}

function mapVerificationStatus(status: unknown) {
  switch (status) {
    case "incorrect_code":
      return "code_invalid";
    case "expired":
    case "too_many_attempts":
    case "already_used":
    case "invalid_challenge":
      return status;
    default:
      return "service_unavailable";
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return jsonResponse({ ok: false, code: "invalid_input" }, 405);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 8192) return jsonResponse({ ok: false, code: "invalid_input" }, 413);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  let configuration: { serviceKey: string; verificationSecret: string };
  try {
    configuration = {
      serviceKey: getServiceKey(),
      verificationSecret: getHmacSecret(),
    };
  } catch (error) {
    console.error("Profile identity verification secrets are not configured.", error);
    return jsonResponse({ ok: false, code: "service_unavailable" }, 503);
  }
  const { serviceKey, verificationSecret } = configuration;
  if (!supabaseUrl || !serviceKey) {
    console.error("Supabase Edge Function credentials are not configured.");
    return jsonResponse({ ok: false, code: "service_unavailable" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return jsonResponse({ ok: false, code: "invalid_input" }, 413);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return jsonResponse({ ok: false, code: "invalid_input" }, 400);
    body = parsed;
  } catch {
    return jsonResponse({ ok: false, code: "invalid_input" }, 400);
  }

  const user = await getAuthorizedUser(request, supabaseUrl);
  if (!user) return jsonResponse({ ok: false, code: "service_unavailable" }, 401);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (body.action === "cancel") {
      if (typeof body.challengeId !== "string") return jsonResponse({ ok: false, code: "invalid_input" });
      const { data, error } = await admin.rpc("cancel_profile_settings_verification_v1", {
        p_challenge_id: body.challengeId,
        p_user_id: user.id,
      });
      if (error) {
        console.error("Could not cancel an identity-verification challenge.", { code: error.code });
        return jsonResponse({ ok: false, code: "service_unavailable" });
      }
      return jsonResponse({ ok: data === true, code: data === true ? undefined : "invalid_challenge" });
    }

    const currentProfile = await getCurrentProfile(admin, user.id);
    const operation = await normalizeOperation(body.operation, user, currentProfile, verificationSecret);
    if (!operation) return jsonResponse({ ok: false, code: "invalid_input" });

    if (body.action === "request") {
      const issued = await issueChallenge(admin, user, operation, verificationSecret);
      if (issued.status !== "issued") {
        return jsonResponse({
          ok: false,
          code: issued.status,
          retryAt: issued.retryAt,
          retryAfterSeconds: issued.retryAfterSeconds,
        });
      }
      return jsonResponse({ ok: true, challenge: issued.challenge });
    }

    if (body.action !== "verify") return jsonResponse({ ok: false, code: "invalid_input" });
    if (
      typeof body.challengeId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(body.challengeId)
      || typeof body.code !== "string"
      || !/^\d{6}$/.test(body.code)
    ) {
      return jsonResponse({ ok: false, code: "invalid_input" });
    }

    const codeDigest = await hmacHex(
      verificationSecret,
      `profile-code:v1:${user.id}:${body.challengeId}:${body.code}`,
    );
    if (!digestPattern.test(operation.operationDigest) || !digestPattern.test(codeDigest)) {
      return jsonResponse({ ok: false, code: "service_unavailable" });
    }

    const { data, error } = await admin.rpc("verify_and_apply_profile_settings_v1", {
      p_challenge_id: body.challengeId,
      p_user_id: user.id,
      p_operation_digest: operation.operationDigest,
      p_code_digest: codeDigest,
      p_full_name: operation.fullName,
      p_phone: operation.phone,
      p_update_phone: operation.updatePhone,
      p_update_profile: operation.updateProfile,
    });
    if (error) {
      console.error("Could not verify and apply the requested profile change.", { code: error.code });
      return jsonResponse({ ok: false, code: "service_unavailable" });
    }

    const result = Array.isArray(data) ? data[0] : null;
    if (!result || result.status !== "verified") {
      return jsonResponse({ ok: false, code: mapVerificationStatus(result?.status) });
    }
    if (
      typeof result.full_name !== "string"
      || (result.phone !== null && typeof result.phone !== "string")
    ) {
      console.error("The profile verification RPC returned an invalid profile shape.");
      return jsonResponse({ ok: false, code: "service_unavailable" });
    }

    return jsonResponse({
      ok: true,
      profile: { full_name: result.full_name, phone: result.phone },
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "service_unavailable") {
      console.error("Profile identity verification failed.", error);
    }
    return jsonResponse({ ok: false, code });
  }
});
