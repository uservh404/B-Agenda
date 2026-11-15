import { supabase } from "../lib/supabaseClient";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface ResourceItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  storedIn: string;
  notes: string[];
  version: number;
  updatedAt: string;
}

export interface ResourceInput {
  name: string;
  category: string;
  quantity: number;
  storedIn: string;
  notes: string[];
}

export interface ResourceInventorySummary {
  resourceCount: number;
  totalUnits: number;
}

export interface ApplyResourceOperationRequest {
  operationId: string;
  kind: "create" | "update" | "delete";
  resourceId: string;
  expectedVersion: number;
  input?: ResourceInput;
}

export type ApplyResourceOperationResult =
  | {
    status: "confirmed";
    resourceId: string;
    version: number;
    resource: ResourceItem | null;
  }
  | { status: "conflict" | "rejected"; code: string };

export const RESOURCE_RETENTION_DAYS = 60;

const resourceColumns = "id, name, category, quantity, stored_in, notes, version, updated_at";
let subscriptionSequence = 0;

async function ensureAuthenticatedUser(expectedUserId: string): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error || data.session?.user.id !== expectedUserId) {
    throw new Error("La sesión actual no corresponde a la cuenta activa de Recursos.");
  }
}

function parseResource(value: unknown): ResourceItem {
  if (!value || typeof value !== "object") {
    throw new Error("Supabase devolvió un recurso no válido.");
  }

  const row = value as Partial<{
    id: string;
    name: string;
    category: string;
    quantity: number;
    stored_in: string;
    notes: string[];
    version: number;
    updated_at: string;
  }>;
  if (
    typeof row.id !== "string"
    || typeof row.name !== "string"
    || typeof row.category !== "string"
    || typeof row.quantity !== "number"
    || !Number.isInteger(row.quantity)
    || row.quantity < 0
    || typeof row.stored_in !== "string"
    || !Array.isArray(row.notes)
    || !row.notes.every((note) => typeof note === "string")
    || typeof row.version !== "number"
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.updated_at !== "string"
    || Number.isNaN(Date.parse(row.updated_at))
  ) {
    throw new Error("Supabase devolvió datos de recurso incompletos.");
  }

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    storedIn: row.stored_in,
    notes: row.notes,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function toDatabaseResource(resource: ResourceInput) {
  return {
    name: resource.name,
    category: resource.category,
    quantity: resource.quantity,
    stored_in: resource.storedIn,
    notes: resource.notes,
  };
}

export async function listResources(expectedUserId?: string): Promise<ResourceItem[]> {
  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase
    .from("resources")
    .select(resourceColumns)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;
  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  if (!Array.isArray(data)) {
    throw new Error("Supabase devolvió una lista de recursos no válida.");
  }
  return data.map(parseResource);
}

function parseSummaryCount(value: unknown): number {
  const count = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Supabase devolvió un resumen de inventario no válido.");
  }
  return count;
}

export async function getResourceInventorySummary(): Promise<ResourceInventorySummary> {
  const { data, error } = await supabase.rpc("resource_inventory_summary_v1");
  if (error) throw error;
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object") {
    throw new Error("Supabase devolvió un resumen de inventario no válido.");
  }

  const summary = data[0] as Partial<{ resource_count: unknown; total_units: unknown }>;
  return {
    resourceCount: parseSummaryCount(summary.resource_count),
    totalUnits: parseSummaryCount(summary.total_units),
  };
}

export async function applyResourceOperation(
  operation: ApplyResourceOperationRequest,
  expectedUserId?: string,
): Promise<ApplyResourceOperationResult> {
  if (
    !operation.operationId
    || !operation.resourceId
    || !Number.isSafeInteger(operation.expectedVersion)
    || operation.expectedVersion < 0
    || (operation.kind === "create" && !operation.input)
    || (operation.kind === "update" && !operation.input)
  ) {
    throw new Error("La operación pendiente de Recursos no es válida.");
  }

  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase.rpc("apply_resource_operation_v1", {
    p_operation_id: operation.operationId,
    p_kind: operation.kind,
    p_resource_id: operation.resourceId,
    p_expected_version: operation.expectedVersion,
    p_payload: operation.input ? toDatabaseResource(operation.input) : {},
  });

  if (error) throw error;
  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  if (!data || typeof data !== "object") {
    throw new Error("El servidor devolvió una respuesta de sincronización no válida.");
  }

  const response = data as Partial<{
    status: string;
    code: string;
    resource_id: string;
    version: number;
    resource: unknown;
  }>;
  if (response.status === "conflict" || response.status === "rejected") {
    if (typeof response.code !== "string") {
      throw new Error("El servidor devolvió un motivo de rechazo no válido.");
    }
    return { status: response.status, code: response.code };
  }
  if (
    response.status !== "confirmed"
    || response.resource_id !== operation.resourceId
    || typeof response.version !== "number"
    || !Number.isSafeInteger(response.version)
  ) {
    throw new Error("El servidor no confirmó correctamente el cambio de Recursos.");
  }

  const resource = response.resource === null ? null : parseResource(response.resource);
  if (
    (operation.kind === "delete" && resource !== null)
    || (resource
      && (resource.id !== operation.resourceId || resource.version !== response.version))
  ) {
    throw new Error("El recurso confirmado no coincide con la operación pendiente.");
  }

  return {
    status: "confirmed",
    resourceId: response.resource_id,
    version: response.version,
    resource,
  };
}

export async function getResourceManagementPermission(expectedUserId?: string): Promise<boolean> {
  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  const { data, error } = await supabase.rpc("can_manage_resources");
  if (error) throw error;
  if (expectedUserId) await ensureAuthenticatedUser(expectedUserId);
  if (typeof data !== "boolean") {
    throw new Error("Supabase devolvió un permiso de Recursos no válido.");
  }
  return data;
}

export type ResourceRealtimeStatus =
  | "SUBSCRIBED"
  | "TIMED_OUT"
  | "CLOSED"
  | "CHANNEL_ERROR";

export function subscribeToResourceChangeSignals(
  userId: string,
  onChange: () => void,
  onStatus: (status: ResourceRealtimeStatus) => void,
): RealtimeChannel {
  return supabase
    .channel(`resources:${userId}:${++subscriptionSequence}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "resource_change_signals",
        filter: "id=eq.1",
      },
      onChange,
    )
    .subscribe((status) => {
      if (
        status === "SUBSCRIBED"
        || status === "TIMED_OUT"
        || status === "CLOSED"
        || status === "CHANNEL_ERROR"
      ) {
        onStatus(status);
      }
    });
}

export function removeResourceChangeSignalSubscription(channel: RealtimeChannel) {
  return supabase.removeChannel(channel);
}
