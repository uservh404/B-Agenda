export type UserRole = "administrador" | "empleado";

let authenticatedRole: UserRole | null = null;

export function getCurrentUserRole(): UserRole {
  return authenticatedRole ?? "empleado";
}

export function isAdministrator(): boolean {
  return authenticatedRole === "administrador";
}

export function setAuthenticatedProfile(_userId: string, role: UserRole) {
  authenticatedRole = role;
}

export function clearAuthenticatedProfile() {
  authenticatedRole = null;
}