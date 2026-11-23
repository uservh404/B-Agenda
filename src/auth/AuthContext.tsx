import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { isTauri } from "@tauri-apps/api/core";
import { supabase } from "../lib/supabaseClient";
import { clearAuthenticatedProfile, setAuthenticatedProfile, type UserRole } from "./permissions";
import { AuthContext, getEffectiveProfile, type AuthState, type AuthProfile } from "./auth-context";
import {
  cancelProfileSettingsVerification,
  requestProfileSettingsVerification,
  verifyAndApplyProfileSettings,
} from "../services/profile-settings-verification";
import type { ProfileSettingsOperation } from "../services/profile-settings-verification";
import {
  clearPasswordRecovery,
  getVerifiedRecoveryUser,
  storeVerifiedRecoveryUser,
} from "./password-recovery";
import {
  clearOfflineIdentity,
  isOfflineAccountSuspended,
  loadOfflineIdentity,
  saveOfflineIdentity,
  setOfflineAccountSuspension,
} from "./offline-identity";
import { checkCurrentAccountStatus } from "./account-suspension";
import {
  ACCOUNT_SUSPENSION_DETECTED_EVENT,
  hasConfirmedAccountSuspension,
} from "./account-suspension-response";

const initialState: AuthState = {
  status: "loading",
  session: null,
  user: null,
  profile: null,
  error: null,
};

function isUserRole(role: unknown): role is UserRole {
  return role === "administrador" || role === "empleado";
}

function isNetworkUnavailable(error: unknown) {
  if (!window.navigator.onLine) return true;
  const errorRecord = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; name?: unknown }
    : null;
  const details = [
    error instanceof Error ? error.name : errorRecord?.name,
    errorRecord?.code,
    error instanceof Error ? error.message : errorRecord?.message,
  ].map((value) => String(value ?? "")).join(" ");
  return /authretryablefetcherror|failed to fetch|fetch failed|networkerror|network request failed|connection refused|timed out|timeout|aborterror|econn|enetunreach/i.test(details);
}

function isServerAuthorizationRejection(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const errorRecord = error as { status?: unknown; code?: unknown; message?: unknown };
  const details = [errorRecord.code, errorRecord.message].map((value) => String(value ?? "")).join(" ");
  return errorRecord.status === 401
    || errorRecord.status === 403
    || /pgrst301|invalid jwt|jwt expired|not authenticated|unauthorized/i.test(details);
}

function isConfirmedAuthSuspension(error: unknown) {
  return hasConfirmedAccountSuspension(error);
}

function getSafeErrorDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return "unknown";
  const record = error as { name?: unknown; code?: unknown; status?: unknown };
  if (typeof record.status === "number") return `HTTP_${record.status}`;
  if (typeof record.code === "string" && /^[A-Z0-9_-]{1,32}$/i.test(record.code)) return record.code;
  if (typeof record.name === "string" && /^[A-Z0-9_-]{1,48}$/i.test(record.name)) return record.name;
  return "unknown";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(initialState);
  const authStateRef = useRef(authState);
  useLayoutEffect(() => {
    authStateRef.current = authState;
  }, [authState]);
  const requestId = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const offlineIdentityQueue = useRef<Promise<void>>(Promise.resolve());
  const realtimeChannelClose = useRef<Promise<void>>(Promise.resolve());
  const suspensionCheckInFlight = useRef(false);
  const profileCache = useRef(new Map<string, AuthProfile>());
  const profileRequests = useRef(new Map<string, Promise<{
    profile: AuthProfile | null;
    unavailableOffline: boolean;
    identityRejected: boolean;
    suspensionConfirmed: boolean;
  }>>());
  const enqueueOfflineIdentityOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = offlineIdentityQueue.current.then(operation);
    offlineIdentityQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);
  const updateAuthState = useCallback((nextState: AuthState) => {
    authStateRef.current = nextState;
    setAuthState(nextState);
  }, []);
  const closeRealtimeChannels = useCallback(() => {
    realtimeChannelClose.current = (async () => {
      try {
        const results = await supabase.removeAllChannels();
        const unsuccessful = results.filter((result) => result !== "ok");
        if (unsuccessful.length > 0) {
          console.error(
            "No se pudo confirmar el cierre de todos los canales Realtime tras confirmar la suspensión.",
            unsuccessful,
          );
        }
      } catch (error) {
        console.error(
          "No se pudieron cerrar los canales Realtime tras confirmar la suspensión.",
          getSafeErrorDiagnostic(error),
        );
      }
    })();
  }, []);
  const persistOfflineIdentity = useCallback(async (session: Session, currentRequestId: number) => {
    try {
      await enqueueOfflineIdentityOperation(async () => {
        if (currentRequestId === requestId.current) {
          const saved = await saveOfflineIdentity(session.user.id, session.access_token);
          if (!saved) {
            console.warn("No se guardó la identidad offline porque el puente nativo de Tauri no está disponible.");
          }
        }
      });
    } catch (error) {
      console.warn(
        "No se pudo guardar y confirmar la identidad local protegida.",
        getSafeErrorDiagnostic(error),
      );
    }
  }, [enqueueOfflineIdentityOperation]);

  const markAuthCheckError = useCallback((
    session: Session | null,
    message: string,
    serverConfirmedActive = false,
  ): AuthState => {
    const currentState = authStateRef.current;
    if (
      !serverConfirmedActive
      && currentState.status === "suspended"
      && (!session || currentState.user?.id === session.user.id)
    ) {
      return currentState;
    }

    requestId.current += 1;
    if (session) sessionRef.current = session;
    clearAuthenticatedProfile();
    const nextState: AuthState = {
      status: "error",
      session,
      user: session?.user ?? null,
      profile: null,
      error: message,
    };
    updateAuthState(nextState);
    return nextState;
  }, [updateAuthState]);

  const markAccountSuspended = useCallback(async (
    session: Session | null,
    userId: string,
    email: string | null,
  ): Promise<AuthState> => {
    const currentState = authStateRef.current;
    const alreadySuspended = currentState.status === "suspended"
      && currentState.user?.id === userId;
    requestId.current += 1;
    if (session) sessionRef.current = session;
    clearAuthenticatedProfile();
    const nextState: AuthState = {
      status: "suspended",
      session,
      user: session?.user ?? { id: userId, email, suspended: true, authorization: null },
      profile: null,
      error: null,
    };
    updateAuthState(nextState);
    if (!alreadySuspended) closeRealtimeChannels();
    try {
      await enqueueOfflineIdentityOperation(() => setOfflineAccountSuspension(userId, true));
    } catch (error) {
      console.error(
        "No se pudo guardar el bloqueo local confirmado por Supabase.",
        getSafeErrorDiagnostic(error),
      );
      const currentState = authStateRef.current;
      if (currentState.status === "suspended" && currentState.user?.id === userId) {
        updateAuthState({
          ...currentState,
          error: "No se pudo guardar el bloqueo local protegido. Mantén esta aplicación abierta y contacta al administrador.",
        });
      }
    }
    return authStateRef.current;
  }, [closeRealtimeChannels, enqueueOfflineIdentityOperation, updateAuthState]);

  const markAuthSuspendedFromError = useCallback(async (
    session: Session | null,
    error: unknown,
    expectedRequestId?: number,
  ) => {
    if (!isConfirmedAuthSuspension(error)) return null;
    if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) return null;
    if (session) {
      return markAccountSuspended(session, session.user.id, session.user.email ?? null);
    }
    try {
      const identity = await enqueueOfflineIdentityOperation(() => loadOfflineIdentity());
      if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) return null;
      if (identity) {
        return markAccountSuspended(null, identity.id, identity.email);
      }
    } catch (identityError) {
      console.error(
        "No se pudo identificar la cuenta tras la confirmación de suspensión de Supabase.",
        getSafeErrorDiagnostic(identityError),
      );
    }
    if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) return null;
    const alreadySuspended = authStateRef.current.status === "suspended";
    requestId.current += 1;
    clearAuthenticatedProfile();
    const nextState: AuthState = {
      status: "suspended",
      session: null,
      user: null,
      profile: null,
      error: null,
    };
    updateAuthState(nextState);
    if (!alreadySuspended) closeRealtimeChannels();
    return nextState;
  }, [closeRealtimeChannels, enqueueOfflineIdentityOperation, markAccountSuspended, updateAuthState]);

  useEffect(() => {
    const handleConfirmedSuspension = (event: Event) => {
      const detail = event instanceof CustomEvent
        ? event.detail as { userId?: unknown }
        : null;
      const rejectedUserId = typeof detail?.userId === "string" ? detail.userId : null;
      const session = sessionRef.current;
      const currentState = authStateRef.current;
      const currentUserId = session?.user.id ?? currentState.user?.id ?? null;

      if (rejectedUserId && currentUserId && rejectedUserId !== currentUserId) {
        void enqueueOfflineIdentityOperation(
          () => setOfflineAccountSuspension(rejectedUserId, true),
        ).catch((error: unknown) => {
          console.error(
            "No se pudo guardar el bloqueo local confirmado por Supabase.",
            getSafeErrorDiagnostic(error),
          );
        });
        return;
      }
      if (session) {
        void markAccountSuspended(session, session.user.id, session.user.email ?? null);
      } else if (currentState.user?.id) {
        void markAccountSuspended(null, currentState.user.id, currentState.user.email ?? null);
      } else if (rejectedUserId) {
        void markAccountSuspended(null, rejectedUserId, null);
      } else {
        void markAuthSuspendedFromError(null, { status: 403, code: "account_suspended" });
      }
    };

    window.addEventListener(ACCOUNT_SUSPENSION_DETECTED_EVENT, handleConfirmedSuspension);
    return () => {
      window.removeEventListener(ACCOUNT_SUSPENSION_DETECTED_EVENT, handleConfirmedSuspension);
    };
  }, [enqueueOfflineIdentityOperation, markAccountSuspended, markAuthSuspendedFromError]);

  const restoreOfflineIdentity = useCallback(async (
    expectedUserId?: string,
    expectedRequestId?: number,
    serverConfirmedActive = false,
  ): Promise<AuthState | null> => {
    if (!isTauri()) return null;
    try {
      if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) {
        return null;
      }
      const currentState = authStateRef.current;
      if (
        !serverConfirmedActive
        && currentState.status === "suspended"
        && expectedUserId
        && currentState.user?.id === expectedUserId
      ) {
        return currentState;
      }
      const identity = await enqueueOfflineIdentityOperation(() => loadOfflineIdentity());
      if (!identity) {
        console.warn("Acceso offline: no se encontró el marcador protegido en el almacenamiento local de esta aplicación.");
        return null;
      }
      if (expectedUserId && identity.id !== expectedUserId) {
        console.warn("Acceso offline: el marcador protegido no corresponde a la sesión local recuperada.");
        return null;
      }
      const latestState = authStateRef.current;
      if (
        !serverConfirmedActive
        && latestState.status === "suspended"
        && latestState.user?.id === identity.id
      ) {
        return latestState;
      }
      const alreadySuspended = latestState.status === "suspended"
        && latestState.user?.id === identity.id;
      if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) {
        return null;
      }
      requestId.current += 1;
      clearAuthenticatedProfile();
      const profile = identity.suspended
        ? null
        : profileCache.current.get(identity.id) ?? identity.authorization;
      if (profile) setAuthenticatedProfile(profile.id, profile.role);
      const nextState: AuthState = {
        status: identity.suspended ? "suspended" : "offline",
        session: null,
        user: { ...identity, authorization: identity.authorization ?? null },
        profile,
        error: null,
      };
      updateAuthState(nextState);
      if (identity.suspended && !alreadySuspended) closeRealtimeChannels();
      return nextState;
    } catch (error) {
      console.error(
        "No se pudo comprobar la identidad local protegida.",
        getSafeErrorDiagnostic(error),
      );
      return null;
    }
  }, [closeRealtimeChannels, enqueueOfflineIdentityOperation, updateAuthState]);

  const processSession = useCallback(async (
    session: Session | null,
    isRecoveryEvent = false,
    forceProfileRefresh = false,
  ): Promise<AuthState> => {
    const currentRequestId = ++requestId.current;
    sessionRef.current = session;

    if (!session) {
      if (authStateRef.current.status === "suspended") {
        return authStateRef.current;
      }
      profileCache.current.clear();
      profileRequests.current.clear();
      clearPasswordRecovery();
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "unauthenticated",
        session: null,
        user: null,
        profile: null,
        error: null,
      };
      updateAuthState(nextState);
      return nextState;
    }

    if (forceProfileRefresh) {
      profileCache.current.delete(session.user.id);
    }

    if (!window.navigator.onLine) {
      const offlineState = await restoreOfflineIdentity(session.user.id, currentRequestId);
      if (offlineState) return offlineState;
      if (currentRequestId !== requestId.current) return authStateRef.current;
      return markAuthCheckError(
        session,
        "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
      );
    }

    const accountStatus = await checkCurrentAccountStatus(session.access_token);
    if (currentRequestId !== requestId.current) return authStateRef.current;

    const currentAuthState = authStateRef.current;
    if (
      accountStatus.status === "unavailable"
      && currentAuthState.status === "suspended"
      && currentAuthState.user?.id === session.user.id
    ) {
      console.warn(
        "Se conserva la suspensión confirmada; el servidor no confirmó una reactivación.",
        getSafeErrorDiagnostic(accountStatus.error),
      );
      return currentAuthState;
    }
    if (accountStatus.status === "unavailable") {
      if (isServerAuthorizationRejection(accountStatus.error)) {
        return markAuthCheckError(
          session,
          "Supabase no pudo validar esta sesión. El acceso permanece bloqueado; vuelve a iniciar sesión.",
        );
      }
      const offlineState = await restoreOfflineIdentity(session.user.id, currentRequestId);
      if (offlineState) return offlineState;
      if (currentRequestId !== requestId.current) return authStateRef.current;
      return markAuthCheckError(
        session,
        "No se pudo confirmar el estado de la cuenta. El acceso permanece bloqueado; inténtalo nuevamente.",
      );
    }
    if (accountStatus.status === "suspended") {
      return markAccountSuspended(session, session.user.id, session.user.email ?? null);
    }
    if (accountStatus.status === "active") {
      let locallySuspended = false;
      try {
        locallySuspended = await enqueueOfflineIdentityOperation(
          () => isOfflineAccountSuspended(session.user.id),
        );
        if (currentRequestId !== requestId.current) return authStateRef.current;
        if (locallySuspended) {
          await enqueueOfflineIdentityOperation(
            () => setOfflineAccountSuspension(session.user.id, false, session.access_token),
          );
        }
      } catch (error) {
        console.error(
          "Supabase confirmó la cuenta activa, pero no se pudo actualizar su estado local.",
          getSafeErrorDiagnostic(error),
        );
        const latestState = authStateRef.current;
        if (latestState.status === "suspended" && latestState.user?.id === session.user.id) {
          return latestState;
        }
        if (locallySuspended) {
          return markAccountSuspended(session, session.user.id, session.user.email ?? null);
        }
      }
      if (currentRequestId !== requestId.current) return authStateRef.current;
    }

    if (authStateRef.current.status === "suspended") {
      await realtimeChannelClose.current;
      if (currentRequestId !== requestId.current) return authStateRef.current;
    }

    if (isRecoveryEvent) {
      storeVerifiedRecoveryUser(session.user.id);
    }
    if (isRecoveryEvent || getVerifiedRecoveryUser() === session.user.id) {
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "recovery",
        session,
        user: session.user,
        profile: null,
        error: null,
      };
      updateAuthState(nextState);
      return nextState;
    }

    const cachedProfile = profileCache.current.get(session.user.id);
    if (cachedProfile) {
      void persistOfflineIdentity(session, currentRequestId);
      if (currentRequestId !== requestId.current) {
        return authStateRef.current;
      }
      setAuthenticatedProfile(cachedProfile.id, cachedProfile.role);
      const nextState: AuthState = {
        status: "authenticated",
        session,
        user: session.user,
        profile: cachedProfile,
        error: null,
      };
      updateAuthState(nextState);
      return nextState;
    }

    clearAuthenticatedProfile();
    updateAuthState({
      status: "loading",
      session,
      user: session.user,
      profile: null,
      error: null,
    });

    let profileRequest = profileRequests.current.get(session.user.id);
    if (!profileRequest) {
      profileRequest = (async () => {
        try {
          const { data, error } = await supabase
            .from("profiles")
            .select("id, full_name, phone, role, can_assign_events, can_publish_announcements")
            .eq("id", session.user.id)
            .maybeSingle();

          if (error) {
            return {
              profile: null,
              unavailableOffline: isNetworkUnavailable(error),
              identityRejected: isServerAuthorizationRejection(error),
              suspensionConfirmed: isConfirmedAuthSuspension(error),
            };
          }

          if (
            !data
            || !isUserRole(data.role)
            || typeof data.can_assign_events !== "boolean"
            || typeof data.can_publish_announcements !== "boolean"
          ) {
            return {
              profile: null,
              unavailableOffline: false,
              identityRejected: true,
              suspensionConfirmed: false,
            };
          }

          return {
            profile: getEffectiveProfile({
              id: data.id,
              full_name: data.full_name,
              phone: data.phone,
              role: data.role,
              can_assign_events: data.can_assign_events,
              can_publish_announcements: data.can_publish_announcements,
            }),
            unavailableOffline: false,
            identityRejected: false,
            suspensionConfirmed: false,
          };
        } catch (error) {
          return {
            profile: null,
            unavailableOffline: isNetworkUnavailable(error),
            identityRejected: isServerAuthorizationRejection(error),
            suspensionConfirmed: isConfirmedAuthSuspension(error),
          };
        }
      })();
      profileRequests.current.set(session.user.id, profileRequest);
    }

    const profileResult = await profileRequest;
    if (profileRequests.current.get(session.user.id) === profileRequest) {
      profileRequests.current.delete(session.user.id);
    }

    if (currentRequestId !== requestId.current) {
      return authStateRef.current;
    }

    if (!profileResult.profile && profileResult.suspensionConfirmed) {
      return markAccountSuspended(session, session.user.id, session.user.email ?? null);
    }

    if (
      !profileResult.profile
      && !profileResult.identityRejected
      && !profileResult.suspensionConfirmed
    ) {
      const offlineState = await restoreOfflineIdentity(
        session.user.id,
        currentRequestId,
        accountStatus.status === "active",
      );
      if (offlineState) return offlineState;
      if (currentRequestId !== requestId.current) return authStateRef.current;
      if (profileResult.unavailableOffline) {
        return markAuthCheckError(
          session,
          "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
          accountStatus.status === "active",
        );
      }
    }

    if (!profileResult.profile) {
      if (profileResult.identityRejected) {
        try {
          await enqueueOfflineIdentityOperation(async () => {
            if (currentRequestId !== requestId.current) return;
            const identity = await loadOfflineIdentity();
            if (
              currentRequestId === requestId.current
              && identity?.id === session.user.id
            ) {
              await clearOfflineIdentity();
            }
          });
        } catch (error) {
          console.error(
            "No se pudo quitar la identidad local tras el rechazo del servidor.",
            getSafeErrorDiagnostic(error),
          );
        }
      }
      if (currentRequestId !== requestId.current) return authStateRef.current;
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "error",
        session,
        user: session.user,
        profile: null,
        error: "No se pudo consultar un perfil válido. El acceso permanece bloqueado.",
      };
      updateAuthState(nextState);
      return nextState;
    }

    const profile = profileResult.profile;
    profileCache.current.set(session.user.id, profile);
    setAuthenticatedProfile(profile.id, profile.role);
    void persistOfflineIdentity(session, currentRequestId);
    if (currentRequestId !== requestId.current) {
      return authStateRef.current;
    }
    const nextState: AuthState = {
      status: "authenticated",
      session,
      user: session.user,
      profile,
      error: null,
    };
    updateAuthState(nextState);
    return nextState;
  }, [
    restoreOfflineIdentity,
    markAuthCheckError,
    markAccountSuspended,
    persistOfflineIdentity,
    enqueueOfflineIdentityOperation,
    updateAuthState,
  ]);

  const removeOfflineIdentity = useCallback(async (
    expectedRequestId?: number,
    expectedUserId?: string,
  ) => {
    if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) return false;
    if (authStateRef.current.status === "suspended") return false;
    if (!isTauri()) return true;
    try {
      await enqueueOfflineIdentityOperation(async () => {
        if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) return;
        if (authStateRef.current.status === "suspended") {
          throw new Error("No se puede quitar la identidad local de una cuenta suspendida.");
        }
        if (!expectedUserId) return;
        const identity = await loadOfflineIdentity();
        if (
          (expectedRequestId !== undefined && expectedRequestId !== requestId.current)
          || !identity
          || identity.id !== expectedUserId
        ) {
          return;
        }
        await clearOfflineIdentity();
      });
      return true;
    } catch (error) {
      console.error(
        "No se pudo quitar la identidad local protegida.",
        getSafeErrorDiagnostic(error),
      );
      return false;
    }
  }, [enqueueOfflineIdentityOperation]);

  const markSessionOffline = useCallback(async (
    session: Session,
    expectedRequestId?: number,
  ): Promise<AuthState> => {
    const restored = await restoreOfflineIdentity(session.user.id, expectedRequestId);
    if (restored) return restored;
    if (expectedRequestId !== undefined && expectedRequestId !== requestId.current) {
      return authStateRef.current;
    }
    if (
      authStateRef.current.status === "suspended"
      && authStateRef.current.user?.id === session.user.id
    ) {
      return authStateRef.current;
    }
    requestId.current += 1;
    sessionRef.current = session;
    clearAuthenticatedProfile();
    const nextState: AuthState = {
      status: "error",
      session,
      user: session.user,
      profile: null,
      error: "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
    };
    updateAuthState(nextState);
    return nextState;
  }, [restoreOfflineIdentity, updateAuthState]);

  const refreshAuth = useCallback(async () => {
    const refreshRequestId = requestId.current;
    const startingState = authStateRef.current;
    const startingUserId = startingState.session?.user.id ?? startingState.user?.id ?? undefined;
    if (startingState.status === "suspended" && !window.navigator.onLine) {
      return startingState;
    }

    try {
      const { data, error } = await supabase.auth.getSession();
      if (refreshRequestId !== requestId.current) return authStateRef.current;

      if (error) {
        const session = data.session
          ?? (startingState.status === "suspended" ? startingState.session : sessionRef.current);
        const suspensionState = await markAuthSuspendedFromError(session, error, refreshRequestId);
        if (suspensionState) return suspensionState;
        if (refreshRequestId !== requestId.current) return authStateRef.current;
        if (authStateRef.current.status === "suspended") return authStateRef.current;

        if (isNetworkUnavailable(error)) {
          const restored = await restoreOfflineIdentity(
            session?.user.id ?? startingUserId,
            refreshRequestId,
          );
          if (restored) return restored;
          if (refreshRequestId !== requestId.current) return authStateRef.current;
          if (session) return markSessionOffline(session, refreshRequestId);
        } else if (isServerAuthorizationRejection(error)) {
          await removeOfflineIdentity(refreshRequestId, session?.user.id);
          if (refreshRequestId !== requestId.current) return authStateRef.current;
        } else {
          console.warn(
            "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
            getSafeErrorDiagnostic(error),
          );
          const restored = await restoreOfflineIdentity(
            session?.user.id ?? startingUserId,
            refreshRequestId,
          );
          if (restored) return restored;
          if (refreshRequestId !== requestId.current) return authStateRef.current;
        }
        return markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
      }

      if (!data.session) {
        if (!window.navigator.onLine) {
          const restored = await restoreOfflineIdentity(startingUserId, refreshRequestId);
          if (restored) return restored;
          if (refreshRequestId !== requestId.current) return authStateRef.current;
        }
        if (authStateRef.current.status === "suspended") return authStateRef.current;
        return processSession(null);
      }

      return processSession(data.session, false, true);
    } catch (error) {
      if (refreshRequestId !== requestId.current) return authStateRef.current;
      const session = startingState.status === "suspended"
        ? startingState.session
        : sessionRef.current;
      const suspensionState = await markAuthSuspendedFromError(session, error, refreshRequestId);
      if (suspensionState) return suspensionState;
      if (refreshRequestId !== requestId.current) return authStateRef.current;
      if (authStateRef.current.status === "suspended") return authStateRef.current;
      if (isNetworkUnavailable(error)) {
        const restored = await restoreOfflineIdentity(
          session?.user.id ?? startingUserId,
          refreshRequestId,
        );
        if (restored) return restored;
        if (refreshRequestId !== requestId.current) return authStateRef.current;
        if (session) return markSessionOffline(session, refreshRequestId);
      } else if (isServerAuthorizationRejection(error)) {
        await removeOfflineIdentity(refreshRequestId, session?.user.id);
        if (refreshRequestId !== requestId.current) return authStateRef.current;
      }
      return markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
    }
  }, [
    processSession,
    markAuthSuspendedFromError,
    markSessionOffline,
    markAuthCheckError,
    restoreOfflineIdentity,
    removeOfflineIdentity,
  ]);

  const signOut = useCallback(async (scope: "local" | "global" = "local") => {
    const startingState = authStateRef.current;
    const userId = startingState.session?.user.id ?? startingState.user?.id ?? undefined;
    const requestIdAtStart = requestId.current;
    const wasSuspended = startingState.status === "suspended";

    const identityRemoved = wasSuspended
      ? true
      : await removeOfflineIdentity(requestIdAtStart, userId);
    if (!identityRemoved) return "No se pudo quitar el acceso sin conexión. Inténtalo nuevamente.";
    if (requestIdAtStart !== requestId.current) {
      const currentState = authStateRef.current;
      if (currentState.status === "unauthenticated") return null;
      const currentUserId = currentState.session?.user.id ?? currentState.user?.id;
      if (userId && currentUserId && currentUserId !== userId) return null;
      return "La sesión cambió durante el cierre. Inténtalo nuevamente.";
    }

    const { error } = await supabase.auth.signOut({ scope });
    if (error) {
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) return "No se pudo cerrar la sesión. Inténtalo nuevamente.";
      } catch {
        return "No se pudo confirmar el cierre de sesión. Inténtalo nuevamente.";
      }
    }

    const currentState = authStateRef.current;
    const currentUserId = currentState.session?.user.id ?? currentState.user?.id;
    if (currentState.status === "suspended" && (!userId || currentUserId === userId)) {
      sessionRef.current = null;
      updateAuthState({ ...currentState, session: null });
      return null;
    }
    if (
      requestIdAtStart !== requestId.current
      && currentUserId
      && userId
      && currentUserId !== userId
    ) {
      return null;
    }
    if (requestIdAtStart !== requestId.current && currentState.status === "unauthenticated") {
      return null;
    }
    await processSession(null);
    return null;
  }, [processSession, removeOfflineIdentity, updateAuthState]);

  const requestSettingsVerification = useCallback(async (operation: ProfileSettingsOperation) => {
    if (authState.status !== "authenticated" || !authState.user || !authState.profile) {
      return { ok: false as const, code: "service_unavailable" as const };
    }
    return requestProfileSettingsVerification(operation);
  }, [authState]);

  const verifySettingsAndApply = useCallback(async (
    challengeId: string,
    code: string,
    operation: ProfileSettingsOperation,
  ) => {
    if (authState.status !== "authenticated" || !authState.user || !authState.profile) {
      return { ok: false as const, code: "service_unavailable" as const };
    }

    const result = await verifyAndApplyProfileSettings(challengeId, code, operation);
    if (!result.ok) return result;

    const userId = authState.user.id;
    const updatedProfile: AuthProfile = {
      ...authState.profile,
      full_name: result.profile.full_name,
      phone: result.profile.phone,
    };
    profileCache.current.set(userId, updatedProfile);
    setAuthState((current) => {
      if (current.status !== "authenticated" || current.user?.id !== userId) return current;
      return { ...current, profile: updatedProfile };
    });
    const currentState = authStateRef.current;
    if (
      currentState.status === "authenticated"
      && currentState.user?.id === userId
      && currentState.session
    ) {
      void persistOfflineIdentity(currentState.session, requestId.current);
    }
    return result;
  }, [authState, persistOfflineIdentity]);

  const cancelSettingsVerification = useCallback(
    (challengeId: string) => cancelProfileSettingsVerification(challengeId),
    [],
  );

  useEffect(() => {
    let mounted = true;
    const handleOnline = () => {
      if (!mounted) return;
      const currentState = authStateRef.current;
      if (currentState.status === "offline" || currentState.status === "authenticated") {
        requestId.current += 1;
        updateAuthState({ ...currentState, status: "loading", error: null });
      }
      void refreshAuth();
    };
    const handleOffline = () => {
      if (!mounted) return;
      const currentState = authStateRef.current;
      if (currentState.status === "suspended") return;
      const session = sessionRef.current;
      const userId = session?.user.id ?? currentState.user?.id;
      if (!userId || getVerifiedRecoveryUser() === userId) return;
      const currentRequestId = ++requestId.current;
      void (async () => {
        const restored = await restoreOfflineIdentity(userId, currentRequestId);
        if (
          !restored
          && mounted
          && currentRequestId === requestId.current
        ) {
          markAuthCheckError(
            session,
            "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
          );
        }
      })();
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      queueMicrotask(() => {
        if (!mounted || (event === "INITIAL_SESSION" && !session)) return;
        if (event === "SIGNED_OUT" && !session) {
          if (authStateRef.current.status === "suspended") return;
          const signOutRequestId = requestId.current;
          if (!window.navigator.onLine) {
            void restoreOfflineIdentity(undefined, signOutRequestId);
          } else if (sessionRef.current) {
            const previousSession = sessionRef.current;
            void checkCurrentAccountStatus(previousSession.access_token).then(async (accountStatus) => {
              if (!mounted || signOutRequestId !== requestId.current) return;
              if (accountStatus.status === "suspended") {
                await markAccountSuspended(
                  previousSession,
                  previousSession.user.id,
                  previousSession.user.email ?? null,
                );
                return;
              }
              if (accountStatus.status === "unavailable") {
                console.warn(
                  "No se pudo determinar por qué terminó la sesión.",
                  getSafeErrorDiagnostic(accountStatus.error),
                );
                const offlineState = await restoreOfflineIdentity(
                  previousSession.user.id,
                  signOutRequestId,
                );
                if (offlineState) return;
                if (!mounted || signOutRequestId !== requestId.current) return;
              }
              await removeOfflineIdentity(signOutRequestId, previousSession.user.id);
              if (!mounted || signOutRequestId !== requestId.current) return;
              await processSession(null);
            });
          } else {
            void removeOfflineIdentity(signOutRequestId).then(() => {
              if (mounted && signOutRequestId === requestId.current) {
                void processSession(null);
              }
            });
          }
          return;
        }
        const refreshProfile = event === "SIGNED_IN"
          || event === "TOKEN_REFRESHED"
          || event === "USER_UPDATED";
        void processSession(session, event === "PASSWORD_RECOVERY", refreshProfile);
      });
    });

    const initialSessionRequestId = requestId.current;
    void supabase.auth.getSession().then(async ({ data, error }) => {
      if (!mounted || initialSessionRequestId !== requestId.current) return;
      if (error) {
        const session = data.session ?? sessionRef.current;
        const suspensionState = await markAuthSuspendedFromError(
          session,
          error,
          initialSessionRequestId,
        );
        if (suspensionState) return;
        if (!mounted || initialSessionRequestId !== requestId.current) return;
        if (isNetworkUnavailable(error)) {
          void restoreOfflineIdentity(
            session?.user.id,
            initialSessionRequestId,
          ).then((restored) => {
            if (!restored && mounted && initialSessionRequestId === requestId.current) {
              if (session) void markSessionOffline(session, initialSessionRequestId);
              else markAuthCheckError(null, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
            }
          });
        } else if (isServerAuthorizationRejection(error)) {
          await removeOfflineIdentity(initialSessionRequestId, session?.user.id);
          if (initialSessionRequestId !== requestId.current) return;
          markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
        } else {
          console.warn(
            "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
            getSafeErrorDiagnostic(error),
          );
          void restoreOfflineIdentity(
            session?.user.id,
            initialSessionRequestId,
          ).then((restored) => {
            if (!restored && mounted && initialSessionRequestId === requestId.current) {
              if (session) void markSessionOffline(session, initialSessionRequestId);
              else markAuthCheckError(null, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
            }
          });
        }
        return;
      }
      if (!data.session) {
        void restoreOfflineIdentity(undefined, initialSessionRequestId).then((restored) => {
          if (
            !restored
            && mounted
            && initialSessionRequestId === requestId.current
          ) void processSession(null);
        });
        return;
      }
      void processSession(data.session, false, true);
    }).catch((error: unknown) => {
      if (!mounted || initialSessionRequestId !== requestId.current) return;
      const session = sessionRef.current;
      void markAuthSuspendedFromError(
        session,
        error,
        initialSessionRequestId,
      ).then(async (suspensionState) => {
        if (
          !mounted
          || suspensionState
          || initialSessionRequestId !== requestId.current
        ) return;
        void restoreOfflineIdentity(
          session?.user.id,
          initialSessionRequestId,
        ).then(async (restored) => {
          if (restored || !mounted || initialSessionRequestId !== requestId.current) return;
          if (isNetworkUnavailable(error) && session) {
            void markSessionOffline(session, initialSessionRequestId);
          } else if (isServerAuthorizationRejection(error)) {
            await removeOfflineIdentity(initialSessionRequestId, session?.user.id);
            if (!mounted || initialSessionRequestId !== requestId.current) return;
            markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
          } else {
            console.warn(
              "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
              getSafeErrorDiagnostic(error),
            );
            if (session) void markSessionOffline(session, initialSessionRequestId);
            else markAuthCheckError(null, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
          }
        });
      });
    });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      mounted = false;
      subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [
    processSession,
    refreshAuth,
    markSessionOffline,
    markAuthCheckError,
    markAccountSuspended,
    markAuthSuspendedFromError,
    restoreOfflineIdentity,
    removeOfflineIdentity,
    updateAuthState,
  ]);

  useEffect(() => {
    const session = authState.session;
    const userId = session?.user.id;
    if (!userId) return;
    let active = true;

    const verifySuspension = async () => {
      if (!window.navigator.onLine || suspensionCheckInFlight.current) return;
      suspensionCheckInFlight.current = true;
      const checkRequestId = requestId.current;
      try {
        const result = await checkCurrentAccountStatus(session.access_token);
        if (
          !active
          || checkRequestId !== requestId.current
          || sessionRef.current?.user.id !== userId
        ) return;
        if (result.status === "suspended") {
          await markAccountSuspended(session, userId, session.user.email ?? null);
          return;
        }
        if (result.status === "active") {
          if (authStateRef.current.status === "suspended") {
            await processSession(session, false, true);
          }
          return;
        }
        console.warn(
          "No se pudo comprobar periódicamente el estado de suspensión.",
          getSafeErrorDiagnostic(result.error),
        );
        if (
          authStateRef.current.status === "suspended"
          && isServerAuthorizationRejection(result.error)
        ) {
          await refreshAuth();
        }
      } catch (error) {
        console.error(
          "Falló la comprobación periódica del estado de suspensión.",
          getSafeErrorDiagnostic(error),
        );
      } finally {
        suspensionCheckInFlight.current = false;
      }
    };

    const verifyWhenVisible = () => {
      if (document.visibilityState === "visible") void verifySuspension();
    };
    const intervalId = window.setInterval(() => { void verifySuspension(); }, 60_000);
    window.addEventListener("focus", verifyWhenVisible);
    document.addEventListener("visibilitychange", verifyWhenVisible);
    void verifySuspension();

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", verifyWhenVisible);
      document.removeEventListener("visibilitychange", verifyWhenVisible);
    };
  }, [
    authState.session,
    authState.status,
    markAccountSuspended,
    processSession,
    refreshAuth,
  ]);

  const value = useMemo(() => ({
    ...authState,
    refreshAuth,
    signOut,
    requestProfileSettingsVerification: requestSettingsVerification,
    verifyAndApplyProfileSettings: verifySettingsAndApply,
    cancelProfileSettingsVerification: cancelSettingsVerification,
  }), [
    authState,
    refreshAuth,
    signOut,
    requestSettingsVerification,
    verifySettingsAndApply,
    cancelSettingsVerification,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
