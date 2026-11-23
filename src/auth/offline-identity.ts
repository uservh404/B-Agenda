import { invoke, isTauri } from "@tauri-apps/api/core";
import { supabasePublishableKey, supabaseUrl } from "../lib/supabaseClient";

export interface OfflineUserIdentity {
  id: string;
  email: string | null;
  suspended: boolean;
  authorization: OfflineAuthorizationProfile | null;
}

export interface OfflineAuthorizationProfile {
  id: string;
  full_name: string;
  phone: string | null;
  role: "administrador" | "empleado";
  can_assign_events: boolean;
  can_publish_announcements: boolean;
  can_manage_resources: boolean | null;
}

function isOfflineAuthorizationProfile(value: unknown): value is OfflineAuthorizationProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<OfflineAuthorizationProfile>;
  return typeof profile.id === "string"
    && typeof profile.full_name === "string"
    && (profile.phone === null || typeof profile.phone === "string")
    && (profile.role === "administrador" || profile.role === "empleado")
    && typeof profile.can_assign_events === "boolean"
    && typeof profile.can_publish_announcements === "boolean"
    && (profile.can_manage_resources === null || typeof profile.can_manage_resources === "boolean");
}

function isOfflineUserIdentity(value: unknown): value is OfflineUserIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<OfflineUserIdentity>;
  return typeof identity.id === "string"
    && identity.id.length > 0
    && (identity.email === null || typeof identity.email === "string")
    && typeof identity.suspended === "boolean"
    && (
      identity.authorization === null
      || isOfflineAuthorizationProfile(identity.authorization)
    );
}

export async function saveOfflineIdentity(
  userId: string,
  accessToken: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke("save_offline_identity", {
    userId,
    accessToken,
    supabaseUrl,
    publishableKey: supabasePublishableKey,
  });
  return true;
}

export async function loadOfflineIdentity(): Promise<OfflineUserIdentity | null> {
  if (!isTauri()) {
    throw new Error("El puente nativo de Tauri no está disponible en este contexto.");
  }
  const identity: unknown = await invoke("load_offline_identity", { supabaseUrl });
  if (identity === null) return null;
  if (!isOfflineUserIdentity(identity)) {
    throw new Error("La identidad local guardada no tiene un formato válido.");
  }
  return { ...identity, authorization: identity.authorization ?? null };
}

export async function isOfflineAccountSuspended(userId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("is_offline_account_suspended", { userId, supabaseUrl });
}

export async function setOfflineAccountSuspension(
  userId: string,
  suspended: boolean,
  accessToken?: string,
): Promise<void> {
  if (!isTauri()) return;
  if (!suspended && !accessToken) {
    throw new Error("Supabase debe confirmar la reactivación antes de quitar el bloqueo local.");
  }
  await invoke("set_offline_account_suspension", {
    userId,
    supabaseUrl,
    suspended,
    accessToken: accessToken ?? null,
    publishableKey: supabasePublishableKey,
  });
}

export async function clearOfflineIdentity(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clear_offline_identity");
}
