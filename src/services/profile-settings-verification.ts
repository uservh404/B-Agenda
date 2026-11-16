import { supabase } from "../lib/supabaseClient";

export interface ProfileSettingsOperation {
  fullName: string;
  phone: string | null;
  updatePhone: boolean;
  updateProfile: boolean;
  newEmail: string | null;
}

export type ProfileVerificationErrorCode =
  | "already_used"
  | "code_invalid"
  | "email_change_pending"
  | "email_delivery_failed"
  | "email_not_verified"
  | "expired"
  | "invalid_challenge"
  | "invalid_input"
  | "network_error"
  | "no_changes"
  | "rate_limited"
  | "resend_cooldown"
  | "service_unavailable"
  | "too_many_attempts";

export interface ProfileVerificationChallenge {
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
  resendAvailableAt: string;
}

export interface VerifiedProfileSettings {
  full_name: string;
  phone: string | null;
}

export type ProfileVerificationRequestResult =
  | { ok: true; challenge: ProfileVerificationChallenge }
  | {
    ok: false;
    code: ProfileVerificationErrorCode;
    retryAt?: string;
    retryAfterSeconds?: number;
  };

export type ProfileVerificationApplyResult =
  | { ok: true; profile: VerifiedProfileSettings }
  | { ok: false; code: ProfileVerificationErrorCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseErrorCode(value: unknown): ProfileVerificationErrorCode {
  switch (value) {
    case "already_used":
    case "code_invalid":
    case "email_change_pending":
    case "email_delivery_failed":
    case "email_not_verified":
    case "expired":
    case "invalid_challenge":
    case "invalid_input":
    case "no_changes":
    case "rate_limited":
    case "resend_cooldown":
    case "too_many_attempts":
      return value;
    default:
      return "service_unavailable";
  }
}

async function invokeVerificationFunction(body: Record<string, unknown>) {
  try {
    const { data, error } = await supabase.functions.invoke<unknown>(
      "profile-settings-verification",
      { body },
    );
    if (error) return { data: null, error };
    if (!isRecord(data)) return { data: null, error: new Error("Respuesta de verificación inválida.") };
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error("No se pudo contactar al servicio de verificación."),
    };
  }
}

function formatOperation(operation: ProfileSettingsOperation) {
  return {
    fullName: operation.fullName,
    phone: operation.phone,
    updatePhone: operation.updatePhone,
    newEmail: operation.newEmail,
  };
}

export async function requestProfileSettingsVerification(
  operation: ProfileSettingsOperation,
): Promise<ProfileVerificationRequestResult> {
  const { data, error } = await invokeVerificationFunction({
    action: "request",
    operation: formatOperation(operation),
  });
  if (error || !data) {
    console.error("No se pudo solicitar la verificación de identidad.", error);
    return { ok: false, code: "network_error" };
  }
  if (data.ok !== true) {
    const retryAt = typeof data.retryAt === "string" && Number.isFinite(Date.parse(data.retryAt))
      ? data.retryAt
      : undefined;
    const retryAfterSeconds = typeof data.retryAfterSeconds === "number"
      && Number.isFinite(data.retryAfterSeconds)
      && data.retryAfterSeconds > 0
      ? Math.ceil(data.retryAfterSeconds)
      : undefined;
    return {
      ok: false,
      code: parseErrorCode(data.code),
      ...(retryAt ? { retryAt } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  const challenge = data.challenge;
  if (
    !isRecord(challenge)
    || typeof challenge.id !== "string"
    || typeof challenge.maskedEmail !== "string"
    || typeof challenge.expiresAt !== "string"
    || !Number.isFinite(Date.parse(challenge.expiresAt))
  ) {
    console.error("El servicio devolvió una solicitud de verificación incompleta.");
    return { ok: false, code: "service_unavailable" };
  }

  const resendAvailableAt = typeof challenge.resendAvailableAt === "string"
    && Number.isFinite(Date.parse(challenge.resendAvailableAt))
    ? challenge.resendAvailableAt
    : new Date(Date.now() + 60_000).toISOString();

  return {
    ok: true,
    challenge: {
      challengeId: challenge.id,
      maskedEmail: challenge.maskedEmail,
      expiresAt: challenge.expiresAt,
      resendAvailableAt,
    },
  };
}

export async function verifyAndApplyProfileSettings(
  challengeId: string,
  code: string,
  operation: ProfileSettingsOperation,
): Promise<ProfileVerificationApplyResult> {
  const { data, error } = await invokeVerificationFunction({
    action: "verify",
    challengeId,
    code,
    operation: formatOperation(operation),
  });
  if (error || !data) {
    console.error("No se pudo completar la verificación de identidad.", error);
    return { ok: false, code: "network_error" };
  }
  if (data.ok !== true) return { ok: false, code: parseErrorCode(data.code) };

  const profile = data.profile;
  if (
    !isRecord(profile)
    || typeof profile.full_name !== "string"
    || (profile.phone !== null && typeof profile.phone !== "string")
  ) {
    console.error("El servicio devolvió un perfil verificado con formato inválido.");
    return { ok: false, code: "service_unavailable" };
  }

  return {
    ok: true,
    profile: {
      full_name: profile.full_name,
      phone: profile.phone,
    },
  };
}

export async function cancelProfileSettingsVerification(challengeId: string): Promise<boolean> {
  const { data, error } = await invokeVerificationFunction({
    action: "cancel",
    challengeId,
  });
  if (error || !data) {
    console.error("No se pudo cancelar la verificación en el servidor.", error);
    return false;
  }
  if (data.ok !== true) return false;
  return true;
}
