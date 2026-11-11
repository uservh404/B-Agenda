import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";
import { clearAuthenticatedProfile, setAuthenticatedProfile, type UserRole } from "./permissions";
import { AuthContext, type AuthState, type AuthProfile } from "./auth-context";
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(initialState);
  const requestId = useRef(0);
  const profileCache = useRef(new Map<string, AuthProfile>());
  const profileRequests = useRef(new Map<string, Promise<AuthProfile | null>>());

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

          if (
            error
            || !data
            || !isUserRole(data.role)
            || typeof data.can_assign_events !== "boolean"
            || typeof data.can_publish_announcements !== "boolean"
          ) {
            return null;
          }

          return {
            id: data.id,
            full_name: data.full_name,
            phone: data.phone,
            role: data.role,
            can_assign_events: data.can_assign_events,
            can_publish_announcements: data.can_publish_announcements,
          };
        } catch {
          return null;
        }
      })();
      profileRequests.current.set(session.user.id, profileRequest);
    }

    const profile = await profileRequest;
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

    if (!profile) {
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

  useEffect(() => {
    let mounted = true;
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

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [processSession]);

  const value = useMemo(() => ({
    ...authState,
    refreshAuth,
    signOut,
  }), [authState, refreshAuth, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
