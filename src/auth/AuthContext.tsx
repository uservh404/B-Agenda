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
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  return /failed to fetch|fetch failed|networkerror|network request failed|connection refused|timed out/i.test(message);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(initialState);
  const requestId = useRef(0);
  const profileCache = useRef(new Map<string, AuthProfile>());
  const profileRequests = useRef(new Map<string, Promise<{ profile: AuthProfile | null; unavailableOffline: boolean }>>());

  const processSession = useCallback(async (session: Session | null, isRecoveryEvent = false): Promise<AuthState> => {
    const currentRequestId = ++requestId.current;

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

    const cachedProfile = profileCache.current.get(session.user.id);
    if (cachedProfile) {
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
            return { profile: null, unavailableOffline: isNetworkUnavailable(error) };
          }

          if (
            !data
            || !isUserRole(data.role)
            || typeof data.can_assign_events !== "boolean"
            || typeof data.can_publish_announcements !== "boolean"
          ) {
            return { profile: null, unavailableOffline: false };
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
          };
        } catch (error) {
          return { profile: null, unavailableOffline: isNetworkUnavailable(error) };
        }
      })();
      profileRequests.current.set(session.user.id, profileRequest);
    }

    const profileResult = await profileRequest;
    profileRequests.current.delete(session.user.id);

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
      clearAuthenticatedProfile();
      const nextState: AuthState = {
        status: "offline",
        session,
        user: session.user,
        profile: null,
        error: null,
      };
      setAuthState(nextState);
      return nextState;
    }

    if (!profileResult.profile) {
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
    const nextState: AuthState = {
      status: "authenticated",
      session,
      user: session.user,
      profile,
      error: null,
    };
    setAuthState(nextState);
    return nextState;
  }, []);

  const refreshAuth = useCallback(async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      const nextState: AuthState = {
        status: "error",
        session: null,
        user: null,
        profile: null,
        error: "No se pudo comprobar la sesión. Inténtalo nuevamente.",
      };
      clearAuthenticatedProfile();
      setAuthState(nextState);
      return nextState;
    }
    return processSession(data.session);
  }, [processSession]);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      return "No se pudo cerrar la sesión. Inténtalo nuevamente.";
    }
    await processSession(null);
    return null;
  }, [processSession]);

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
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      queueMicrotask(() => {
        if (mounted) {
          void processSession(session, event === "PASSWORD_RECOVERY");
        }
      });
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        clearAuthenticatedProfile();
        setAuthState({
          status: "error",
          session: null,
          user: null,
          profile: null,
          error: "No se pudo comprobar la sesión. Inténtalo nuevamente.",
        });
        return;
      }
      void processSession(data.session);
    }).catch(() => {
      if (!mounted) return;
      clearAuthenticatedProfile();
      setAuthState({
        status: "error",
        session: null,
        user: null,
        profile: null,
        error: "No se pudo comprobar la sesión. Inténtalo nuevamente.",
      });
    });

    window.addEventListener("online", handleOnline);
    return () => {
      mounted = false;
      subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
    };
  }, [processSession, refreshAuth]);

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
