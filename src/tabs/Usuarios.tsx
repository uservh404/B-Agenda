import { useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import { readUsers, saveUsers, type UserItem } from "../auth/users";
import { getActiveUserId } from "../auth/permissions";
import { addNotification } from "../auth/notifications";
import "./S-principal.css";
import "./S-usuarios.css";

function Usuarios() {
  const [users, setUsers] = useState<UserItem[]>(readUsers);
  const [selectedUser, setSelectedUser] = useState<UserItem | null>(null);
  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<"todos" | UserItem["role"]>("todos");
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserItem | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), 350);
    return () => window.clearTimeout(timer);
  }, []);

  const handleDelete = (user: UserItem) => {
    const updatedUsers = users.filter((item) => item.id !== user.id);
    setUsers(updatedUsers);
    saveUsers(updatedUsers);
    setSelectedUser(null);
    setUserToDelete(null);
    setActionMessage(`El usuario ${user.name} fue eliminado correctamente.`);
  };

  const handleAssignPermissionChange = (userId: number, enabled: boolean) => {
    const updatedUsers = users.map((user) =>
      user.id === userId ? { ...user, canAssignEvents: enabled } : user,
    );
    setUsers(updatedUsers);
    saveUsers(updatedUsers);
    const selectedUser = updatedUsers.find((user) => user.id === userId);
    setActionMessage(`${selectedUser?.name} ${enabled ? "ahora puede" : "ya no puede"} asignar eventos.`);
    if (selectedUser) {
      const actorName = users.find((user) => user.id === getActiveUserId())?.name ?? "Administración";
      addNotification({
        recipientId: userId,
        kind: enabled ? "permission_granted" : "permission_revoked",
        title: enabled ? "Permiso habilitado" : "Permiso actualizado",
        message: enabled
          ? `${actorName} te habilitó el permiso para asignar eventos.`
          : `${actorName} retiró tu permiso para asignar eventos.`,
      });
    }
  };

  const visibleUsers = users
    .filter((user) => roleFilter === "todos" || user.role === roleFilter)
    .filter((user) => {
      const query = searchText.trim().toLowerCase();
      return !query || user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query);
    })
    .sort((firstUser, secondUser) => {
      const comparison = firstUser.name.localeCompare(secondUser.name, "es");
      return sortAscending ? comparison : -comparison;
    });

  return (
    <div className="dashboard users-page">
      <Sidebar />

      <main className="content users-content">
        <header className="content-header users-header">
          <div>
            <span className="users-eyebrow">Administración</span>
            <h1>Usuarios registrados</h1>
            <p>Consulta y administra las personas que tienen acceso a la biblioteca.</p>
          </div>
          <div className="users-total">
            <strong>{users.length}</strong>
            <span>Usuarios</span>
          </div>
        </header>

        <section className="users-panel" aria-label="Lista de usuarios registrados">
          <div className="users-panel-heading">
            <div>
              <h2>Directorio de usuarios</h2>
              <p>Revisa la información de cada cuenta y administra sus permisos.</p>
            </div>
          </div>

          {actionMessage && <p className="users-success" role="status">✓ {actionMessage}</p>}
          <div className="users-controls">
            <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Buscar por nombre o correo" aria-label="Buscar usuarios" />
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as "todos" | UserItem["role"])} aria-label="Filtrar por tipo de usuario">
              <option value="todos">Todos los roles</option>
              <option value="Administrador">Administradores</option>
              <option value="Empleado">Empleados</option>
            </select>
            <button type="button" className="sort-users-button" onClick={() => setSortAscending((ascending) => !ascending)}>{sortAscending ? "A-Z" : "Z-A"}</button>
          </div>

          {loading ? (
            <div className="users-state"><span className="loading-spinner" />Cargando usuarios...</div>
          ) : loadError ? (
            <div className="users-state users-error"><h3>No se pudo cargar la información</h3><button type="button" onClick={() => { setLoadError(false); setLoading(true); window.setTimeout(() => setLoading(false), 350); }}>Intentar de nuevo</button></div>
          ) : users.length === 0 ? (
            <div className="users-empty">
              <span>👥</span>
              <h3>No hay usuarios registrados</h3>
              <p>Cuando se creen nuevas cuentas aparecerán aquí.</p>
            </div>
          ) : visibleUsers.length === 0 ? (
            <div className="users-empty"><span>⌕</span><h3>Sin resultados</h3><p>Prueba con otro nombre, correo o tipo de usuario.</p></div>
          ) : (
            <div className="users-list">
              {visibleUsers.map((user) => (
                <article className="user-row" key={user.id}>
                  <div className="user-avatar">{user.name.charAt(0)}</div>
                  <div className="user-information">
                    <h3>{user.name}</h3>
                    <p>{user.email}</p>
                  </div>
                  <span className={`user-role role-${user.role.toLowerCase()}`}>{user.role}</span>
                  {user.role === "Empleado" ? (
                    <label className="user-event-permission">
                      <span>Puede asignar eventos</span>
                      <input
                        type="checkbox"
                        checked={user.canAssignEvents}
                        onChange={(event) => handleAssignPermissionChange(user.id, event.target.checked)}
                        aria-label={`Permitir que ${user.name} asigne eventos`}
                      />
                    </label>
                  ) : (
                    <span className="admin-event-permission">Permisos completos</span>
                  )}
                  <div className="user-actions">
                    <button type="button" className="user-view-button" onClick={() => setSelectedUser(user)}>
                      Ver usuario
                    </button>
                    <button type="button" className="user-delete-button" onClick={() => setUserToDelete(user)}>
                      Eliminar
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {selectedUser && (
        <div className="user-modal-backdrop" onClick={() => setSelectedUser(null)}>
          <section className="user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="user-modal-close" onClick={() => setSelectedUser(null)} aria-label="Cerrar detalles">
              ✕
            </button>
            <div className="user-avatar user-avatar-large">{selectedUser.name.charAt(0)}</div>
            <span className="users-eyebrow">Detalle de usuario</span>
            <h2 id="user-modal-title">{selectedUser.name}</h2>
            <p><strong>Correo:</strong> {selectedUser.email}</p>
            <p><strong>Teléfono:</strong> {selectedUser.phone}</p>
            <p><strong>Tipo de usuario:</strong> {selectedUser.role}</p>
            <button type="button" className="user-delete-button modal-delete" onClick={() => setUserToDelete(selectedUser)}>
              Eliminar usuario
            </button>
          </section>
        </div>
      )}
      {userToDelete && <ConfirmDialog title="Eliminar usuario" message={`¿Deseas eliminar a ${userToDelete.name}? Esta acción no se puede deshacer.`} onCancel={() => setUserToDelete(null)} onConfirm={() => handleDelete(userToDelete)} />}
    </div>
  );
}

export default Usuarios;