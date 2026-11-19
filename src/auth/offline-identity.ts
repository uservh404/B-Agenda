import { invoke, isTauri } from "@tauri-apps/api/core";
import { supabasePublishableKey, supabaseUrl } from "../lib/supabaseClient";

export interface OfflineUserIdentity {
  id: string;
  email: string | null;
}

function isOfflineUserIdentity(value: unknown): value is OfflineUserIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<OfflineUserIdentity>;
  return typeof identity.id === "string"
    && identity.id.length > 0
    && (identity.email === null || typeof identity.email === "string");
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
  const identity: unknown = await invoke("load_offline_identity");
  if (identity === null) return null;
  if (!isOfflineUserIdentity(identity)) {
    throw new Error("La identidad local guardada no tiene un formato válido.");
  }
  return identity;
}

export async function clearOfflineIdentity(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clear_offline_identity");
}
