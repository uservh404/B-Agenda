export const ACCOUNT_SUSPENSION_DETECTED_EVENT = "agenda-account-suspension-detected";

const confirmedSuspendedUserIds = new Set<string>();
let suspensionEventListenerRegistered = false;

function registerSuspensionEventListener(): void {
  if (typeof window === "undefined" || suspensionEventListenerRegistered) return;
  window.addEventListener(ACCOUNT_SUSPENSION_DETECTED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ userId?: unknown }>).detail;
    if (typeof detail?.userId === "string" && detail.userId) {
      confirmedSuspendedUserIds.add(detail.userId);
    }
  });
  suspensionEventListenerRegistered = true;
}

export function isAccountSuspensionConfirmedInSession(userId: string): boolean {
  registerSuspensionEventListener();
  return confirmedSuspendedUserIds.has(userId);
}

export function clearAccountSuspensionConfirmedInSession(userId: string): void {
  registerSuspensionEventListener();
  confirmedSuspendedUserIds.delete(userId);
}

export function notifyConfirmedAccountSuspension(userId: string): void {
  registerSuspensionEventListener();
  confirmedSuspendedUserIds.add(userId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ACCOUNT_SUSPENSION_DETECTED_EVENT, {
      detail: { userId },
    }));
  }
}

function containsSuspensionMarker(value: unknown): boolean {
  return /(?:^|[^a-z0-9_])(?:account_suspended|user_banned)(?=$|[^a-z0-9_])/i
    .test(String(value ?? ""));
}

export function hasConfirmedAccountSuspension(value: unknown): boolean {
  if (typeof value === "string") {
    return containsSuspensionMarker(value);
  }
  if (!value || typeof value !== "object") return false;

  const record = value as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    status?: unknown;
  };
  if (typeof record.status === "number" && record.status !== 403) return false;
  if ([record.code, record.message, record.details]
    .some(containsSuspensionMarker)) {
    return true;
  }

  return record.code === "PGRST121"
    && /Could not parse JSON in the "RAISE SQLSTATE 'PGRST'"/i.test(
      String(record.message ?? ""),
    )
    && /Invalid JSON value for DETAIL:.*["']status["']\s*:\s*403/i.test(
      String(record.details ?? ""),
    );
}

export function isConfirmedSuspensionResponse(status: number, body: unknown): boolean {
  return status === 403 && hasConfirmedAccountSuspension(body);
}
