import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "../components/Sidebar";
import { useAuth } from "../auth/useAuth";
import { supabase } from "../lib/supabaseClient";
import "./S-principal.css";
import "./S-usuarios.css";

type UserRole = "administrador" | "empleado";
type RoleFilter = "todos" | UserRole;

interface AdminUser {
  id: string;
  full_name: string;
  phone: string | null;
  email: string;
  role: UserRole;
  can_assign_events: boolean;
  can_publish_announcements: boolean;
  created_at: string;
  updated_at: string;
}

function isAdminUser(value: unknown): value is AdminUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<AdminUser>;
  return typeof user.id === "string"
    && typeof user.full_name === "string"
    && typeof user.email === "string"
    && (user.role === "administrador" || user.role === "empleado")
    && typeof user.can_assign_events === "boolean"
    && typeof user.can_publish_announcements === "boolean";
}

function displayRole(role: UserRole) {
  return role === "administrador" ? "Administrador" : "Empleado";
}

function Usuarios() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [draftRole, setDraftRole] = useState<UserRole>("empleado");
  const [draftCanAssignEvents, setDraftCanAssignEvents] = useState(false);
  const [draftCanPublishAnnouncements, setDraftCanPublishAnnouncements] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("todos");
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  const loadUsers = useCallback(async (): Promise<AdminUser[] | null> => {
    setLoading(true);
    setLoadError("");

    try {
      const { data, error } = await supabase.rpc("admin_list_users_v2");
      if (error) {
        setUsers([]);
        setLoadError("No se pudo consultar la lista de usuarios. Verifica tu acceso e inténtalo nuevamente.");
        return null;
      }

      if (!Array.isArray(data) || !data.every(isAdminUser)) {
        setUsers([]);
        setLoadError("No se pudo cargar la información de los usuarios. Inténtalo nuevamente.");
        return null;
      }

      setUsers(data);
      return data;
    } catch {
      setUsers([]);
      setLoadError("Ocurrió un error al consultar los usuarios. Inténtalo nuevamente.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadUsers();
    });
  }, [loadUsers]);

  const openUser = (user: AdminUser) => {
    setSelectedUser(user);
    setDraftRole(user.role);
    setDraftCanAssignEvents(user.can_assign_events);
    setDraftCanPublishAnnouncements(user.can_publish_announcements);
    setActionMessage("");
    setActionError("");
  };

  const handleSave = async () => {
    if (!selectedUser || !currentUser || selectedUser.id === currentUser.id || isSaving) return;

    setIsSaving(true);
    setActionMessage("");
    setActionError("");

    try {
      const permissionsChanged = selectedUser.role !== draftRole
        || selectedUser.can_assign_events !== draftCanAssignEvents
        || selectedUser.can_publish_announcements !== draftCanPublishAnnouncements;

      if (permissionsChanged) {
        const { error } = await supabase.rpc("admin_update_user_permissions_v2", {
          p_user_id: selectedUser.id,
          p_role: draftRole,
          p_can_assign_events: draftCanAssignEvents,
          p_can_publish_announcements: draftCanPublishAnnouncements,
        });

        if (error) {
          setActionError("No se pudieron guardar el rol y los permisos. Verifica las restricciones administrativas e inténtalo nuevamente.");
          return;
        }
      }

      if (permissionsChanged) {
        const refreshedUsers = await loadUsers();
        if (!refreshedUsers) {
          setActionError("Los cambios se guardaron correctamente, pero no se pudo actualizar la información mostrada. Intenta cargarla de nuevo.");
          return;
        }
        setSelectedUser(refreshedUsers.find((user) => user.id === selectedUser.id) ?? null);
      }

      setActionMessage("El rol y los permisos se guardaron correctamente.");
    } catch {
      setActionError("Ocurrió un error al guardar los cambios. Revisa la conexión e inténtalo nuevamente.");
    } finally {
      setIsSaving(false);
    }
  };

  const visibleUsers = useMemo(() => users
    .filter((user) => roleFilter === "todos" || user.role === roleFilter)
    .filter((user) => {
      const query = searchText.trim().toLowerCase();
      return !query
        || user.full_name.toLowerCase().includes(query)
        || user.email.toLowerCase().includes(query);
    })
    .sort((firstUser, secondUser) => {
      const comparison = firstUser.full_name.localeCompare(secondUser.full_name, "es");
      return sortAscending ? comparison : -comparison;
    }), [users, roleFilter, searchText, sortAscending]);

  const selectedIsCurrentUser = selectedUser?.id === currentUser?.id;
  const cannotEditSelectedUser = !currentUser || selectedIsCurrentUser;

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
          {actionError && <p className="users-error-message" role="alert">{actionError}</p>}
          <div className="users-controls">
            <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Buscar por nombre o correo" aria-label="Buscar usuarios" />
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as RoleFilter)} aria-label="Filtrar por tipo de usuario">
              <option value="todos">Todos los roles</option>
              <option value="administrador">Administradores</option>
              <option value="empleado">Empleados</option>
            </select>
            <button type="button" className="sort-users-button" onClick={() => setSortAscending((ascending) => !ascending)}>{sortAscending ? "A-Z" : "Z-A"}</button>
          </div>

          {loading ? (
            <div className="users-state"><span className="loading-spinner" />Cargando usuarios...</div>
          ) : loadError ? (
            <div className="users-state users-error">
              <h3>No se pudo cargar la información</h3>
              <p>{loadError}</p>
              <button type="button" onClick={() => { void loadUsers(); }}>Intentar de nuevo</button>
            </div>
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
                  <div className="user-avatar">{user.full_name.charAt(0)}</div>
                  <div className="user-information">
                    <h3>{user.full_name}</h3>
                    <p>{user.email}</p>
                    <p>{user.phone || "Teléfono no registrado"}</p>
                  </div>
                  <span className={`user-role role-${user.role}`}>{displayRole(user.role)}</span>
                  <span className="admin-event-permission">
                    {user.can_assign_events ? "Puede asignar eventos" : "Sin permiso para asignar"}
                  </span>
                  <div className="user-actions">
                    <button type="button" className="user-view-button" onClick={() => openUser(user)}>
                      Ver y administrar
                    </button>
                    <button
                      type="button"
                      className="user-delete-button"
                      disabled
                      title="La eliminación segura de cuentas está pendiente de configuración."
                    >
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
            <div className="user-avatar user-avatar-large">{selectedUser.full_name.charAt(0)}</div>
            <span className="users-eyebrow">Detalle de usuario</span>
            <h3 className="user-modal-section-title">Información del trabajador</h3>
            <h2 id="user-modal-title">{selectedUser.full_name}</h2>
            <p><strong>Correo:</strong> {selectedUser.email}</p>
            <p><strong>Teléfono:</strong> {selectedUser.phone || "No registrado"}</p>
            <label className="user-edit-field" htmlFor="user-role">Rol</label>
            <select
              id="user-role"
              value={draftRole}
              onChange={(event) => setDraftRole(event.target.value as UserRole)}
              disabled={cannotEditSelectedUser || isSaving}
            >
              <option value="empleado">Empleado</option>
              <option value="administrador">Administrador</option>
            </select>
            <h3 className="user-modal-section-title">Permisos</h3>
            <label className="user-event-permission user-edit-permission">
              <span>Puede asignar eventos</span>
              <input
                type="checkbox"
                checked={draftCanAssignEvents}
                onChange={(event) => setDraftCanAssignEvents(event.target.checked)}
                disabled={cannotEditSelectedUser || isSaving}
              />
            </label>
            <label className="user-event-permission user-edit-permission">
              <span>Puede publicar anuncios</span>
              <input
                type="checkbox"
                checked={draftCanPublishAnnouncements}
                onChange={(event) => setDraftCanPublishAnnouncements(event.target.checked)}
                disabled={cannotEditSelectedUser || isSaving}
              />
            </label>
            {!currentUser && <p className="users-error-message">No se pudo verificar tu sesión. Los cambios están bloqueados.</p>}
            {selectedIsCurrentUser && <p className="users-error-message">No puedes modificar tu propio rol ni tus permisos.</p>}
            {actionError && <p className="users-error-message" role="alert">{actionError}</p>}
            {actionMessage && <p className="users-success" role="status">{actionMessage}</p>}
            <button
              type="button"
              className="user-view-button user-save-button"
              onClick={() => { void handleSave(); }}
              disabled={cannotEditSelectedUser || isSaving || (
                selectedUser.role === draftRole
                && selectedUser.can_assign_events === draftCanAssignEvents
                && selectedUser.can_publish_announcements === draftCanPublishAnnouncements
              )}
            >
              {isSaving ? "Guardando..." : "Guardar cambios"}
            </button>
            <button type="button" className="user-delete-button modal-delete" disabled title="La eliminación segura de cuentas está pendiente de configuración.">
              Eliminar usuario
            </button>
            <p className="users-pending-note">La eliminación segura de cuentas está pendiente de configuración.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default Usuarios;
