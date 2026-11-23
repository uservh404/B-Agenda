import { supabase } from "../lib/supabaseClient";
import { checkCurrentAccountStatus } from "../auth/account-suspension";
import {
  clearAccountSuspensionConfirmedInSession,
  hasConfirmedAccountSuspension,
  isAccountSuspensionConfirmedInSession,
  notifyConfirmedAccountSuspension,
} from "../auth/account-suspension-response";

export type OfflineSyncAuthorization =
  | { status: "authorized" | "forbidden" | "suspended" }
  | { status: "unavailable"; error: unknown };

export type OfflineSyncAccount =
  | { status: "active" }
  | { status: "forbidden" | "suspended" }
  | { status: "unavailable"; error: unknown };

export async function checkOfflineSyncAccount(
  userId: string,
): Promise<OfflineSyncAccount> {
  let sessionData;
  try {
    sessionData = await supabase.auth.getSession();
  } catch (error) {
    return { status: "unavailable", error };
  }
  const session = sessionData.data.session;
  if (sessionData.error || session?.user.id !== userId) {
    return {
      status: "unavailable",
      error: sessionData.error ?? new Error("The current session does not match the queued account."),
    };
  }

  const accountStatus = await checkCurrentAccountStatus(session.access_token);
  if (accountStatus.status === "suspended") {
    notifyConfirmedAccountSuspension(userId);
    return { status: "suspended" };
  }
  if (accountStatus.status !== "active") {
    return { status: "unavailable", error: accountStatus.error };
  }
  clearAccountSuspensionConfirmedInSession(userId);
  if (isAccountSuspensionConfirmedInSession(userId)) return { status: "suspended" };

  let profileResult;
  try {
    profileResult = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", userId)
      .maybeSingle();
  } catch (error) {
    return { status: "unavailable", error };
  }
  const { data: profile, error: profileError } = profileResult;
  if (profileError) {
    if (hasConfirmedAccountSuspension(profileError)) {
      notifyConfirmedAccountSuspension(userId);
      return { status: "suspended" };
    }
    return { status: "unavailable", error: profileError };
  }
  if (
    !profile
    || profile.id !== userId
    || (profile.role !== "administrador" && profile.role !== "empleado")
  ) {
    return { status: "forbidden" };
  }
  if (isAccountSuspensionConfirmedInSession(userId)) return { status: "suspended" };

  return { status: "active" };
}

export async function checkOfflineSyncAuthorization(
  userId: string,
  checkPermission: () => Promise<boolean>,
): Promise<OfflineSyncAuthorization> {
  const account = await checkOfflineSyncAccount(userId);
  if (account.status !== "active") return account;

  if (isAccountSuspensionConfirmedInSession(userId)) return { status: "suspended" };

  let permitted: boolean;
  try {
    permitted = await checkPermission();
  } catch (error) {
    if (hasConfirmedAccountSuspension(error)) {
      notifyConfirmedAccountSuspension(userId);
      return { status: "suspended" };
    }
    return { status: "unavailable", error };
  }
  if (isAccountSuspensionConfirmedInSession(userId)) return { status: "suspended" };
  return { status: permitted ? "authorized" : "forbidden" };
}
