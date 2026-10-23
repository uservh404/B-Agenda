export type UserRole = "administrador" | "empleado";

const roleStorageKey = "biblioteca-role";
const activeUserIdStorageKey = "biblioteca-active-user-id";

export function getCurrentUserRole(): UserRole {
  const storedRole = window.localStorage.getItem(roleStorageKey);
  return storedRole === "empleado" ? "empleado" : "administrador";
}

export function isAdministrator(): boolean {
  return getCurrentUserRole() === "administrador";
}

export function getActiveUserId(): number {
  const storedUserId = Number(window.localStorage.getItem(activeUserIdStorageKey));
  if (Number.isInteger(storedUserId) && storedUserId > 0) return storedUserId;
  return getCurrentUserRole() === "empleado" ? 2 : 1;
}

export function setActiveUser(userId: number, role: UserRole) {
  window.localStorage.setItem(activeUserIdStorageKey, String(userId));
  window.localStorage.setItem(roleStorageKey, role);
}