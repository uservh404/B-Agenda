export interface UserItem {
  id: number;
  name: string;
  email: string;
  role: "Administrador" | "Empleado";
  phone: string;
  canAssignEvents: boolean;
}

export const initialUsers: UserItem[] = [
  {
    id: 1,
    name: "María González",
    email: "maria.gonzalez@biblioteca.com",
    role: "Administrador",
    phone: "300 123 4567",
    canAssignEvents: true,
  },
  {
    id: 2,
    name: "Carlos Rodríguez",
    email: "carlos.rodriguez@biblioteca.com",
    role: "Empleado",
    phone: "301 234 5678",
    canAssignEvents: false,
  },
];

const usersStorageKey = "biblioteca-users";

export function readUsers(): UserItem[] {
  try {
    const storedUsers = window.localStorage.getItem(usersStorageKey);
    if (!storedUsers) return initialUsers;
    const parsedUsers: unknown = JSON.parse(storedUsers);
    if (!Array.isArray(parsedUsers)) return initialUsers;
    return (parsedUsers as Partial<UserItem>[]).map((user) => ({
      ...user,
      canAssignEvents: user.role === "Administrador" || user.canAssignEvents === true,
    })) as UserItem[];
  } catch {
    return initialUsers;
  }
}

export function saveUsers(users: UserItem[]) {
  window.localStorage.setItem(usersStorageKey, JSON.stringify(users));
}