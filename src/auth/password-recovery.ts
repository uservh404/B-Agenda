export const PASSWORD_RECOVERY_TTL_MS = 5 * 60 * 1000;
export const PASSWORD_RECOVERY_RESEND_COOLDOWN_MS = 60 * 1000;

const emailKey = "biblioteca-password-recovery-email";
const expiresAtKey = "biblioteca-password-recovery-expires-at";
const resendAtKey = "biblioteca-password-recovery-resend-at";
const verifiedUserIdKey = "biblioteca-password-recovery-verified-user-id";

function readTimestamp(key: string): number {
  const timestamp = Number(sessionStorage.getItem(key));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function getRecoveryEmail(): string {
  return sessionStorage.getItem(emailKey) ?? "";
}

export function storeRecoveryRequest(
  email: string,
  requestedAt = Date.now(),
  cooldownStartedAt = requestedAt,
) {
  sessionStorage.setItem(emailKey, email);
  sessionStorage.setItem(expiresAtKey, String(requestedAt + PASSWORD_RECOVERY_TTL_MS));
  sessionStorage.setItem(resendAtKey, String(cooldownStartedAt + PASSWORD_RECOVERY_RESEND_COOLDOWN_MS));
  sessionStorage.removeItem(verifiedUserIdKey);
}

export function getRecoveryExpiry(): number {
  return readTimestamp(expiresAtKey);
}

export function getRecoveryResendAt(): number {
  return readTimestamp(resendAtKey);
}

export function storeRecoveryResendAt(timestamp: number) {
  sessionStorage.setItem(resendAtKey, String(timestamp));
}

export function storeVerifiedRecoveryUser(userId: string) {
  sessionStorage.setItem(verifiedUserIdKey, userId);
}

export function getVerifiedRecoveryUser(): string {
  return sessionStorage.getItem(verifiedUserIdKey) ?? "";
}

export function clearPasswordRecovery() {
  sessionStorage.removeItem(emailKey);
  sessionStorage.removeItem(expiresAtKey);
  sessionStorage.removeItem(resendAtKey);
  sessionStorage.removeItem(verifiedUserIdKey);
}
