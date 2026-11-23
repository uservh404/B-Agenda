import { supabasePublishableKey, supabaseUrl } from "../lib/supabaseClient";
import { isConfirmedSuspensionResponse } from "./account-suspension-response";

const ACCOUNT_STATUS_TIMEOUT_MS = 10_000;

export type AccountStatusCheck =
  | { status: "active" }
  | { status: "suspended" }
  | { status: "unavailable"; error: unknown };

export async function checkCurrentAccountStatus(
  accessToken: string,
): Promise<AccountStatusCheck> {
  const timeoutSignal = AbortSignal.timeout(ACCOUNT_STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/agenda_account_is_active_v1`,
      {
        method: "POST",
        headers: {
          apikey: supabasePublishableKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: timeoutSignal,
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      return isConfirmedSuspensionResponse(response.status, body)
        ? { status: "suspended" }
        : { status: "unavailable", error: body };
    }
    if (body === true) return { status: "active" };
    if (body === false) return { status: "suspended" };
    return {
      status: "unavailable",
      error: new Error("Supabase devolvió un estado de cuenta inválido."),
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: timeoutSignal.aborted ? new Error("Account status request timed out.") : error,
    };
  }
}
