import { createContext } from "react";
import type { Session, User } from "@supabase/supabase-js";
import type { UserRole } from "./permissions";

export interface AuthProfile {
  id: string;
  full_name: string;
  phone: string | null;
  role: UserRole;
  can_assign_events: boolean;
  can_publish_announcements: boolean;
}

export type AdministrativePermission = "can_assign_events" | "can_publish_announcements";

export function hasAdministrativePermission(
  profile: AuthProfile | null | undefined,
  permission: AdministrativePermission,
): boolean {
  return profile?.role === "administrador" || profile?.[permission] === true;
}

export function getEffectiveProfile(profile: AuthProfile): AuthProfile {
  if (profile.role !== "administrador") return profile;
  return {
    ...profile,
    can_assign_events: true,
    can_publish_announcements: true,
  };
}

export interface AuthState {
  status: "loading" | "unauthenticated" | "authenticated" | "offline" | "recovery" | "error";
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  error: string | null;
}

export interface AuthContextValue extends AuthState {
  refreshAuth: () => Promise<AuthState>;
  signOut: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
