
import { createClient } from '@supabase/supabase-js'
import {
  ACCOUNT_SUSPENSION_DETECTED_EVENT,
  isConfirmedSuspensionResponse,
} from "../auth/account-suspension-response";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
export const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const supabaseKey = supabasePublishableKey

if (!supabaseUrl || !supabaseKey) {
  console.error("Falta configuración necesaria para iniciar la aplicación.", {
    missingUrl: !supabaseUrl,
    missingKey: !supabaseKey,
  })
  throw new Error('No se pudo iniciar la aplicación. Contacta con soporte.')
}

const supabaseOrigin = new URL(supabaseUrl).origin

function getRequestUserId(input: RequestInfo | URL, init?: RequestInit): string | null {
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization") && input instanceof Request) {
      input.headers.forEach((value, key) => headers.set(key, value));
    }
    const authorization = headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return null;

    const tokenParts = authorization.slice("Bearer ".length).split(".");
    if (tokenParts.length !== 3) return null;
    const base64 = tokenParts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(Array.from(binary, (character) => character.charCodeAt(0))),
      ),
    ) as { sub?: unknown };
    return typeof payload.sub === "string" && /^[0-9a-f-]{36}$/i.test(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

async function suspensionAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  if (response.status === 403 && typeof window !== "undefined") {
    const isSupabaseRequest = (() => {
      try {
        const requestUrl = new URL(input instanceof Request ? input.url : String(input), supabaseUrl);
        return requestUrl.origin === supabaseOrigin;
      } catch {
        return false;
      }
    })();
    if (isSupabaseRequest) {
      const userId = getRequestUserId(input, init);
      if (userId) {
        void response.clone().json().then((body: unknown) => {
          if (isConfirmedSuspensionResponse(response.status, body)) {
            window.dispatchEvent(new CustomEvent(ACCOUNT_SUSPENSION_DETECTED_EVENT, {
              detail: { userId },
            }));
          }
        }).catch((error: unknown) => {
          console.warn(
            "No se pudo analizar la respuesta de autorización para detectar suspensión.",
            error instanceof Error ? error.name : "unknown",
          );
        });
      }
    }
  }
  return response;
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: suspensionAwareFetch },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
