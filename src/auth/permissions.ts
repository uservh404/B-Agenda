export type UserRole = "administrador" | "empleado";

const activeUserIdStorageKey = "biblioteca-active-user-id";
let authenticatedRole: UserRole | null = null;

export function getCurrentUserRole(): UserRole {
  return authenticatedRole ?? "empleado";
}

export function isAdministrator(): boolean {
  return authenticatedRole === "administrador";
}

export function getActiveUserId(): number {
  const storedUserId = Number(window.localStorage.getItem(activeUserIdStorageKey));
  if (Number.isInteger(storedUserId) && storedUserId > 0) return storedUserId;
  return 0;
}

export function setActiveUser(userId: number, _role: UserRole) {
  void _role;
  window.localStorage.setItem(activeUserIdStorageKey, String(userId));
}

export function setAuthenticatedProfile(_userId: string, role: UserRole) {
  authenticatedRole = role;
}

export function clearAuthenticatedProfile() {
  authenticatedRole = null;
}