import { supabase } from "../lib/supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface Announcement {
  id: string;
  title: string;
  content: string;
  category: string;
  authorId: string | null;
  authorName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementInput {
  title: string;
  content: string;
  category: string;
}

export type AnnouncementOperationResult =
  | { status: "confirmed"; announcementId: string; version: number; announcement: Announcement | null }
  | { status: "conflict" | "rejected"; code: string };

interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  category: string;
  author_id: string | null;
  author_name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

let subscriptionSequence = 0;

function parseAnnouncement(value: unknown): Announcement {
  if (!value || typeof value !== "object") {
    throw new Error("Supabase devolvió un anuncio no válido.");
  }
  const row = value as Partial<AnnouncementRow>;
  if (
    typeof row.id !== "string"
    || typeof row.title !== "string"
    || typeof row.content !== "string"
    || typeof row.category !== "string"
    || (row.author_id !== null && typeof row.author_id !== "string")
    || typeof row.author_name !== "string"
    || typeof row.version !== "number"
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.created_at !== "string"
    || Number.isNaN(Date.parse(row.created_at))
    || typeof row.updated_at !== "string"
    || Number.isNaN(Date.parse(row.updated_at))
  ) {
    throw new Error("Supabase devolvió datos de anuncio incompletos.");
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    authorId: row.author_id ?? null,
    authorName: row.author_name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureAuthenticatedUser(expectedUserId: string) {
  const { data, error } = await supabase.auth.getSession();
  if (error || data.session?.user.id !== expectedUserId) {
    throw new Error("La sesión actual no corresponde a la cuenta activa de Anuncios.");
  }
}

export async function listAnnouncements(expectedUserId: string): Promise<Announcement[]> {
  await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase.rpc("list_announcements_v1");
  if (error) throw error;
  await ensureAuthenticatedUser(expectedUserId);
  if (!Array.isArray(data)) throw new Error("Supabase devolvió una lista de anuncios no válida.");
  return data.map(parseAnnouncement);
}

export async function canPublishAnnouncements(expectedUserId: string): Promise<boolean> {
  await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase.rpc("can_publish_announcements");
  if (error) throw error;
  await ensureAuthenticatedUser(expectedUserId);
  if (typeof data !== "boolean") {
    throw new Error("Supabase devolvió un permiso de Anuncios no válido.");
  }
  return data;
}

export async function applyAnnouncementOperation(
  operation: {
    operationId: string;
    kind: "create" | "update" | "delete";
    announcementId: string;
    expectedVersion: number;
    input?: AnnouncementInput;
  },
  expectedUserId: string,
): Promise<AnnouncementOperationResult> {
  await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase.rpc("apply_announcement_operation_v1", {
    p_operation_id: operation.operationId,
    p_kind: operation.kind,
    p_announcement_id: operation.announcementId,
    p_expected_version: operation.expectedVersion,
    p_payload: operation.input ?? {},
  });
  if (error) throw error;
  await ensureAuthenticatedUser(expectedUserId);
  if (!data || typeof data !== "object") {
    throw new Error("El servidor devolvió una respuesta de sincronización no válida.");
  }
  const response = data as Partial<{
    status: string;
    code: string;
    announcement_id: string;
    version: number;
    announcement: unknown;
  }>;
  if (response.status === "conflict" || response.status === "rejected") {
    if (typeof response.code !== "string") {
      throw new Error("El servidor devolvió un motivo de rechazo no válido.");
    }
    return { status: response.status, code: response.code };
  }
  if (
    response.status !== "confirmed"
    || response.announcement_id !== operation.announcementId
    || typeof response.version !== "number"
    || !Number.isSafeInteger(response.version)
  ) {
    throw new Error("El servidor no confirmó correctamente el cambio de Anuncios.");
  }
  return {
    status: "confirmed",
    announcementId: response.announcement_id,
    version: response.version,
    announcement: response.announcement === null
      ? null
      : parseAnnouncement(response.announcement),
  };
}

export function subscribeToAnnouncementChanges(
  userId: string,
  onChange: () => void,
  onStatus: (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): RealtimeChannel {
  return supabase
    .channel(`announcement-changes:${userId}:${++subscriptionSequence}`)
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "announcement_change_signals",
      filter: "id=eq.1",
    }, onChange)
    .subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "TIMED_OUT" || status === "CLOSED" || status === "CHANNEL_ERROR") {
        onStatus(status);
      }
    });
}

export function removeAnnouncementChangesSubscription(channel: RealtimeChannel) {
  return supabase.removeChannel(channel);
}

