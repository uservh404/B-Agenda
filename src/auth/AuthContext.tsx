import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
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
  loadOfflineIdentity,
  saveOfflineIdentity,
} from "./offline-identity";

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
  return /authretryablefetcherror|failed to fetch|fetch failed|networkerror|network request failed|connection refused|timed out|econn|enetunreach/i.test(details);
}

function isServerAuthorizationRejection(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const errorRecord = error as { status?: unknown; code?: unknown; message?: unknown };
  const details = [errorRecord.code, errorRecord.message].map((value) => String(value ?? "")).join(" ");
  return errorRecord.status === 401
    || errorRecord.status === 403
    || /pgrst301|invalid jwt|jwt expired|not authenticated|unauthorized/i.test(details);
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
  const requestId = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const offlineIdentityQueue = useRef(Promise.resolve());
  const profileCache = useRef(new Map<string, AuthProfile>());
  const profileRequests = useRef(new Map<string, Promise<{
    profile: AuthProfile | null;
    unavailableOffline: boolean;
    identityRejected: boolean;
  }>>());
  const enqueueOfflineIdentityOperation = useCallback((operation: () => Promise<void>) => {
    const result = offlineIdentityQueue.current.then(operation);
    offlineIdentityQueue.current = result.catch(() => {});
    return result;
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

  const markAuthCheckError = useCallback((session: Session | null, message: string): AuthState => {
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
    setAuthState(nextState);
    return nextState;
  }, []);

  const restoreOfflineIdentity = useCallback(async (
    expectedUserId?: string,
  ): Promise<AuthState | null> => {
    try {
      const identity = await loadOfflineIdentity();
      if (!identity) {
        console.warn("Acceso offline: no se encontró el marcador protegido en el almacenamiento local de esta aplicación.");
        return null;
      }
      if (expectedUserId && identity.id !== expectedUserId) {
        console.warn("Acceso offline: el marcador protegido no corresponde a la sesión local recuperada.");
        return null;
      }
      requestId.current += 1;
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "offline",
        session: null,
        user: identity,
        profile: null,
        error: null,
      };
      setAuthState(nextState);
      return nextState;
    } catch (error) {
      console.error(
        "No se pudo comprobar la identidad local protegida.",
        getSafeErrorDiagnostic(error),
      );
      return null;
    }
  }, []);

  const processSession = useCallback(async (
    session: Session | null,
    isRecoveryEvent = false,
    forceProfileRefresh = false,
  ): Promise<AuthState> => {
    const currentRequestId = ++requestId.current;
    sessionRef.current = session;

    if (!session) {
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
      setAuthState(nextState);
      return nextState;
    }

    if (forceProfileRefresh) {
      profileCache.current.delete(session.user.id);
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
      setAuthState(nextState);
      return nextState;
    }

    if (!window.navigator.onLine) {
      const offlineState = await restoreOfflineIdentity(session.user.id);
      if (offlineState) return offlineState;
      return markAuthCheckError(
        session,
        "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
      );
    }

    const cachedProfile = profileCache.current.get(session.user.id);
    if (cachedProfile) {
      await persistOfflineIdentity(session, currentRequestId);
      if (currentRequestId !== requestId.current) {
        return {
          status: "loading",
          session,
          user: session.user,
          profile: null,
          error: null,
        };
      }
      setAuthenticatedProfile(cachedProfile.id, cachedProfile.role);
      const nextState: AuthState = {
        status: "authenticated",
        session,
        user: session.user,
        profile: cachedProfile,
        error: null,
      };
      setAuthState(nextState);
      return nextState;
    }

    clearAuthenticatedProfile();
    setAuthState({
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
            };
          }

          if (
            !data
            || !isUserRole(data.role)
            || typeof data.can_assign_events !== "boolean"
            || typeof data.can_publish_announcements !== "boolean"
          ) {
            return { profile: null, unavailableOffline: false, identityRejected: true };
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
          };
        } catch (error) {
          return {
            profile: null,
            unavailableOffline: isNetworkUnavailable(error),
            identityRejected: isServerAuthorizationRejection(error),
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
      return {
        status: "loading",
        session,
        user: session.user,
        profile: null,
        error: null,
      };
    }

    if (!profileResult.profile && profileResult.unavailableOffline) {
      const offlineState = await restoreOfflineIdentity(session.user.id);
      if (offlineState) return offlineState;
      return markAuthCheckError(
        session,
        "Esta cuenta no se había preparado para el acceso sin conexión en este equipo.",
      );
    }

    if (!profileResult.profile) {
      if (profileResult.identityRejected) {
        try {
          await enqueueOfflineIdentityOperation(() => clearOfflineIdentity());
        } catch (error) {
          console.error(
            "No se pudo quitar la identidad local tras el rechazo del servidor.",
            getSafeErrorDiagnostic(error),
          );
        }
      }
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "error",
        session,
        user: session.user,
        profile: null,
        error: "No se pudo consultar un perfil válido. El acceso permanece bloqueado.",
      };
      setAuthState(nextState);
      return nextState;
    }

    const profile = profileResult.profile;
    profileCache.current.set(session.user.id, profile);
    setAuthenticatedProfile(profile.id, profile.role);
    await persistOfflineIdentity(session, currentRequestId);
    if (currentRequestId !== requestId.current) {
      return {
        status: "loading",
        session,
        user: session.user,
        profile: null,
        error: null,
      };
    }
    const nextState: AuthState = {
      status: "authenticated",
      session,
      user: session.user,
      profile,
      error: null,
    };
    setAuthState(nextState);
    return nextState;
  }, [
    restoreOfflineIdentity,
    markAuthCheckError,
    persistOfflineIdentity,
    enqueueOfflineIdentityOperation,
  ]);

  const removeOfflineIdentity = useCallback(async () => {
    try {
      await enqueueOfflineIdentityOperation(() => clearOfflineIdentity());
      return true;
    } catch (error) {
      console.error(
        "No se pudo quitar la identidad local protegida.",
        getSafeErrorDiagnostic(error),
      );
      return false;
    }
  }, [enqueueOfflineIdentityOperation]);

  const markSessionOffline = useCallback(async (session: Session): Promise<AuthState> => {
    const restored = await restoreOfflineIdentity(session.user.id);
    if (restored) return restored;
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
    setAuthState(nextState);
    return nextState;
  }, [restoreOfflineIdentity]);

  const refreshAuth = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        const session = data.session ?? sessionRef.current;
        if (isNetworkUnavailable(error)) {
          const restored = await restoreOfflineIdentity(session?.user.id);
          if (restored) return restored;
          if (session) return markSessionOffline(session);
        } else if (isServerAuthorizationRejection(error)) {
          await removeOfflineIdentity();
        } else {
          console.warn(
            "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
            getSafeErrorDiagnostic(error),
          );
          const restored = await restoreOfflineIdentity(session?.user.id);
          if (restored) return restored;
        }
        return markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
      }
      if (!data.session) {
        if (!window.navigator.onLine) {
          const restored = await restoreOfflineIdentity();
          if (restored) return restored;
        }
        return processSession(null);
      }
      return processSession(data.session, false, true);
    } catch (error) {
      const session = sessionRef.current;
      if (isNetworkUnavailable(error)) {
        const restored = await restoreOfflineIdentity(session?.user.id);
        if (restored) return restored;
        if (session) return markSessionOffline(session);
      } else if (isServerAuthorizationRejection(error)) {
        await removeOfflineIdentity();
      }
      return markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
    }
  }, [
    processSession,
    markSessionOffline,
    markAuthCheckError,
    restoreOfflineIdentity,
    removeOfflineIdentity,
  ]);

  const signOut = useCallback(async (scope: "local" | "global" = "local") => {
    const identityRemoved = await removeOfflineIdentity();
    if (!identityRemoved) return "No se pudo quitar el acceso sin conexión. Inténtalo nuevamente.";
    const { error } = await supabase.auth.signOut({ scope });
    if (error) {
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) return "No se pudo cerrar la sesión. Inténtalo nuevamente.";
      } catch {
        return "No se pudo confirmar el cierre de sesión. Inténtalo nuevamente.";
      }
    }
    await processSession(null);
    return null;
  }, [processSession, removeOfflineIdentity]);

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
    return result;
  }, [authState]);

  const cancelSettingsVerification = useCallback(
    (challengeId: string) => cancelProfileSettingsVerification(challengeId),
    [],
  );

  useEffect(() => {
    let mounted = true;
    const handleOnline = () => {
      if (mounted) void refreshAuth();
    };
    const handleOffline = () => {
      if (!mounted) return;
      const session = sessionRef.current;
      const userId = session?.user.id ?? authState.user?.id;
      if (!userId || getVerifiedRecoveryUser() === userId) return;
      void (async () => {
        const restored = await restoreOfflineIdentity(userId);
        if (!restored && mounted) {
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
          if (!window.navigator.onLine) {
            void restoreOfflineIdentity();
          } else {
            void removeOfflineIdentity().then(() => processSession(null));
          }
          return;
        }
        const refreshProfile = event === "SIGNED_IN"
          || event === "TOKEN_REFRESHED"
          || event === "USER_UPDATED";
        void processSession(session, event === "PASSWORD_RECOVERY", refreshProfile);
      });
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        const session = data.session ?? sessionRef.current;
        if (isNetworkUnavailable(error)) {
          void restoreOfflineIdentity(session?.user.id).then((restored) => {
            if (!restored) {
              if (session) void markSessionOffline(session);
              else markAuthCheckError(null, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
            }
          });
        } else if (isServerAuthorizationRejection(error)) {
          void removeOfflineIdentity();
          markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
        } else {
          console.warn(
            "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
            getSafeErrorDiagnostic(error),
          );
          void restoreOfflineIdentity(session?.user.id).then((restored) => {
            if (!restored) {
              if (session) void markSessionOffline(session);
              else markAuthCheckError(null, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
            }
          });
        }
        return;
      }
      if (!data.session) {
        if (!window.navigator.onLine) {
          void restoreOfflineIdentity();
        } else {
          void processSession(null);
        }
        return;
      }
      void processSession(data.session, false, true);
    }).catch((error: unknown) => {
      if (!mounted) return;
      const session = sessionRef.current;
      if (isNetworkUnavailable(error)) {
        void restoreOfflineIdentity(session?.user.id).then((restored) => {
          if (!restored && session) void markSessionOffline(session);
        });
      } else if (isServerAuthorizationRejection(error)) {
        void removeOfflineIdentity();
        markAuthCheckError(session, "No se pudo comprobar la sesión. Inténtalo nuevamente.");
      } else {
        console.warn(
          "No se pudo leer la sesión local de Supabase; se conserva el marcador offline.",
          getSafeErrorDiagnostic(error),
        );
        void restoreOfflineIdentity(session?.user.id).then((restored) => {
          if (!restored && session) void markSessionOffline(session);
        });
      }
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
    restoreOfflineIdentity,
    removeOfflineIdentity,
    authState.user?.id,
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
