import { useCallback, useEffect, useMemo, useState } from "react";
import { UserRoundCheck, UserRoundX } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAuth } from "../auth/useAuth";
import { supabase } from "../lib/supabaseClient";
import {
  getAccountSuspensionStatuses,
  setAccountSuspension,
  type AccountSuspensionAction,
} from "../services/account-suspension";
import "./S-principal.css";
import "./S-usuarios.css";

type UserRole = "administrador" | "empleado";
type RoleFilter = "todos" | UserRole;
type PendingSuspension = { user: AdminUser; action: AccountSuspensionAction };

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

interface ResourcePermissionRow {
  user_id: string;
  role: UserRole;
  can_manage_resources: boolean;
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

function isResourcePermissionRow(value: unknown): value is ResourcePermissionRow {
  if (!value || typeof value !== "object") return false;
  const permission = value as Partial<ResourcePermissionRow>;
  return typeof permission.user_id === "string"
    && (permission.role === "administrador" || permission.role === "empleado")
    && typeof permission.can_manage_resources === "boolean";
}

function displayRole(role: UserRole) {
  return role === "administrador" ? "Administrador" : "Empleado";
}

function getEmployeePermissionSummary(user: AdminUser, canManageResources: boolean) {
  const permissions = [
    user.can_assign_events ? "Puede asignar eventos" : null,
    user.can_publish_announcements ? "Puede publicar anuncios" : null,
    canManageResources ? "Puede administrar recursos" : null,
  ].filter((permission): permission is string => permission !== null);
  return permissions.length > 0 ? permissions.join(" · ") : "Sin permisos";
}

function Usuarios() {
  const { user: currentUser, profile: currentProfile } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [resourcePermissions, setResourcePermissions] = useState<Record<string, boolean>>({});
  const [resourcePermissionsLoaded, setResourcePermissionsLoaded] = useState(false);
  const [resourcePermissionError, setResourcePermissionError] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [draftRole, setDraftRole] = useState<UserRole>("empleado");
  const [draftCanAssignEvents, setDraftCanAssignEvents] = useState(false);
  const [draftCanPublishAnnouncements, setDraftCanPublishAnnouncements] = useState(false);
  const [draftCanManageResources, setDraftCanManageResources] = useState<boolean | null>(null);
  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("todos");
  const [sortAscending, setSortAscending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [suspensionStatuses, setSuspensionStatuses] = useState<Record<string, boolean | null>>({});
  const [suspensionStatusesLoading, setSuspensionStatusesLoading] = useState(false);
  const [suspensionStatusesError, setSuspensionStatusesError] = useState("");
  const [pendingSuspension, setPendingSuspension] = useState<PendingSuspension | null>(null);
  const [isSuspensionSaving, setIsSuspensionSaving] = useState(false);
  const [suspensionActionError, setSuspensionActionError] = useState("");

  const loadUsers = useCallback(async (): Promise<AdminUser[] | null> => {
    setLoading(true);
    setLoadError("");
    setSuspensionStatusesLoading(true);
    setSuspensionStatusesError("");

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
      try {
        const statuses = await getAccountSuspensionStatuses(data.map((user) => user.id));
        setSuspensionStatuses(statuses);
      } catch {
        setSuspensionStatuses(Object.fromEntries(data.map((user) => [user.id, null])));
        setSuspensionStatusesError("No se pudo comprobar el estado de suspensión desde Supabase Auth. Las acciones están bloqueadas.");
      }
      return data;
    } catch {
      setUsers([]);
      setSuspensionStatuses({});
      setLoadError("Ocurrió un error al consultar los usuarios. Inténtalo nuevamente.");
      return null;
    } finally {
      setLoading(false);
      setSuspensionStatusesLoading(false);
    }
  }, []);

  const loadResourcePermissions = useCallback(async (): Promise<boolean> => {
    setResourcePermissionsLoaded(false);
    setResourcePermissionError("");

    try {
      const { data, error } = await supabase.rpc("admin_list_resource_permissions_v1");
      if (error) throw error;
      if (!Array.isArray(data) || !data.every(isResourcePermissionRow)) {
        throw new Error("La respuesta de permisos de Recursos no es válida.");
      }

      const permissions: Record<string, boolean> = {};
      data.forEach((permission) => {
        permissions[permission.user_id] = permission.can_manage_resources;
      });
      setResourcePermissions(permissions);
      setResourcePermissionsLoaded(true);
      return true;
    } catch {
      setResourcePermissions({});
      setResourcePermissionError("No se pudieron cargar los permisos de Recursos. Revisa la migración de Recursos en Supabase.");
      return false;
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadUsers();
    });
  }, [loadUsers]);

  useEffect(() => {
    if (currentProfile?.role !== "administrador") return;
    queueMicrotask(() => {
      void loadResourcePermissions();
    });
  }, [currentProfile?.role, loadResourcePermissions]);

  const openUser = (user: AdminUser) => {
    setSelectedUser(user);
    setDraftRole(user.role);
    setDraftCanAssignEvents(user.can_assign_events);
    setDraftCanPublishAnnouncements(user.can_publish_announcements);
    setDraftCanManageResources(resourcePermissionsLoaded
      ? resourcePermissions[user.id] ?? false
      : null);
    setActionMessage("");
    setActionError("");
  };

  const openSuspensionConfirmation = (user: AdminUser) => {
    const suspended = suspensionStatuses[user.id];
    if (
      currentProfile?.role !== "administrador"
      || user.role !== "empleado"
      || user.id === currentUser?.id
      || typeof suspended !== "boolean"
      || suspensionStatusesLoading
      || isSuspensionSaving
    ) return;

    setPendingSuspension({ user, action: suspended ? "reactivate" : "suspend" });
    setSuspensionActionError("");
    setActionMessage("");
    setActionError("");
  };

  const handleSuspensionConfirmation = async () => {
    if (!pendingSuspension || isSuspensionSaving) return;
    setIsSuspensionSaving(true);
    setSuspensionActionError("");

    try {
      const suspended = await setAccountSuspension(
        pendingSuspension.user.id,
        pendingSuspension.action,
      );
      setSuspensionStatuses((current) => ({
        ...current,
        [pendingSuspension.user.id]: suspended,
      }));
      setActionMessage(pendingSuspension.action === "suspend"
        ? "La cuenta fue suspendida. Las sesiones abiertas pueden seguir activas hasta expirar."
        : "La cuenta fue reactivada y podrá iniciar sesión nuevamente.");
      setPendingSuspension(null);
    } catch (error) {
      setSuspensionActionError(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar el estado de la cuenta. Inténtalo nuevamente.",
      );
    } finally {
      setIsSuspensionSaving(false);
    }
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
      const resourcePermissionChanged = draftResourcePermissionChanged;

      if (!permissionsChanged && !resourcePermissionChanged) return;

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

      if (resourcePermissionChanged) {
        const { data, error } = await supabase.rpc("admin_set_resource_permission_v1", {
          p_user_id: selectedUser.id,
          p_can_manage_resources: effectiveDraftResourcePermission,
        });

        if (error || data !== true) {
          setActionError(permissionsChanged
            ? "El rol y los permisos existentes se guardaron, pero no se pudo actualizar el permiso de Recursos."
            : "No se pudo guardar el permiso de Recursos. Verifica la migración y vuelve a intentarlo.");
          return;
        }
      }

      if (permissionsChanged || resourcePermissionChanged) {
        const refreshedUsers = await loadUsers();
        if (!refreshedUsers) {
          setActionError("Los cambios se guardaron correctamente, pero no se pudo actualizar la información mostrada. Intenta cargarla de nuevo.");
          return;
        }
        if (resourcePermissionChanged && !(await loadResourcePermissions())) {
          setActionError("El permiso de Recursos se guardó, pero no se pudo actualizar su estado mostrado. Vuelve a cargar los permisos.");
          return;
        }
        setSelectedUser(refreshedUsers.find((user) => user.id === selectedUser.id) ?? null);
      }

      setActionMessage(resourcePermissionChanged && !permissionsChanged
        ? "El permiso de Recursos se guardó correctamente."
        : "El rol y los permisos se guardaron correctamente.");
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
  const selectedResourcePermission = selectedUser
    ? resourcePermissions[selectedUser.id] ?? false
    : false;
  const effectiveDraftResourcePermission = draftCanManageResources ?? selectedResourcePermission;
  const draftResourcePermissionChanged = !!selectedUser
    && currentProfile?.role === "administrador"
    && draftRole === "empleado"
    && resourcePermissionsLoaded
    && selectedResourcePermission !== effectiveDraftResourcePermission;

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
          {resourcePermissionError && currentProfile?.role === "administrador" && (
            <p className="users-error-message" role="status">{resourcePermissionError}</p>
          )}
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
                    <span className={`user-account-status ${
                      suspensionStatuses[user.id] === true
                        ? "suspended"
                        : suspensionStatuses[user.id] === false
                          ? "active"
                          : "unknown"
                    }`}>
                      {suspensionStatusesLoading
                        ? "Consultando estado"
                        : suspensionStatuses[user.id] === true
                          ? "Suspendido"
                          : suspensionStatuses[user.id] === false
                            ? "Activo"
                            : "Estado no disponible"}
                    </span>
                  </div>
                  <span className={`user-role role-${user.role}`}>{displayRole(user.role)}</span>
                  <span className="admin-event-permission">
                    {user.role === "administrador"
                      ? "Todos los permisos administrativos habilitados"
                      : !resourcePermissionsLoaded
                        ? resourcePermissionError ? "Permisos no disponibles" : "Consultando permisos..."
                        : getEmployeePermissionSummary(
                          user,
                          resourcePermissions[user.id] ?? false,
                        )}
                  </span>
                  <div className="user-actions">
                    <button type="button" className="user-view-button" onClick={() => openUser(user)}>
                      Ver y administrar
                    </button>
                    {currentProfile?.role === "administrador"
                      && user.role === "empleado"
                      && user.id !== currentUser?.id
                      && typeof suspensionStatuses[user.id] === "boolean" && (
                        <button
                          type="button"
                          className={`user-suspension-button ${
                            suspensionStatuses[user.id] ? "reactivate" : "suspend"
                          }`}
                          aria-label={`${suspensionStatuses[user.id] ? "Reactivar" : "Suspender"} cuenta de ${user.full_name}`}
                          title={`${suspensionStatuses[user.id] ? "Reactivar" : "Suspender"} cuenta`}
                          onClick={() => openSuspensionConfirmation(user)}
                          disabled={suspensionStatusesLoading || isSuspensionSaving}
                        >
                          {suspensionStatuses[user.id]
                            ? <UserRoundCheck size={18} aria-hidden="true" />
                            : <UserRoundX size={18} aria-hidden="true" />}
                        </button>
                      )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {suspensionStatusesError && (
            <p className="users-error-message" role="status">{suspensionStatusesError}</p>
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
            <p>
              <strong>Estado:</strong>{" "}
              {suspensionStatusesLoading
                ? "Consultando"
                : suspensionStatuses[selectedUser.id] === true
                  ? "Suspendido"
                  : suspensionStatuses[selectedUser.id] === false
                    ? "Activo"
                    : "No disponible"}
            </p>
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
                checked={draftRole === "administrador" || draftCanAssignEvents}
                onChange={(event) => setDraftCanAssignEvents(event.target.checked)}
                disabled={cannotEditSelectedUser || isSaving || draftRole === "administrador"}
              />
            </label>
            <label className="user-event-permission user-edit-permission">
              <span>Puede publicar anuncios</span>
              <input
                type="checkbox"
                checked={draftRole === "administrador" || draftCanPublishAnnouncements}
                onChange={(event) => setDraftCanPublishAnnouncements(event.target.checked)}
                disabled={cannotEditSelectedUser || isSaving || draftRole === "administrador"}
              />
            </label>
            {currentProfile?.role === "administrador" && (
              <label className="user-event-permission user-edit-permission">
                <span>Puede administrar Recursos</span>
                <input
                  type="checkbox"
                  checked={draftRole === "administrador" || effectiveDraftResourcePermission}
                  onChange={(event) => setDraftCanManageResources(event.target.checked)}
                  disabled={
                    cannotEditSelectedUser
                    || isSaving
                    || draftRole === "administrador"
                    || !resourcePermissionsLoaded
                  }
                />
              </label>
            )}
            {draftRole === "administrador" && (
              <p className="users-pending-note">
                El rol de administrador habilita automáticamente todos los permisos administrativos.
              </p>
            )}
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
                && (
                  currentProfile?.role !== "administrador"
                  || draftRole === "administrador"
                  || !draftResourcePermissionChanged
                )
              )}
            >
              {isSaving ? "Guardando..." : "Guardar cambios"}
            </button>
          </section>
        </div>
      )}
      {pendingSuspension && (
        <ConfirmDialog
          title={pendingSuspension.action === "suspend" ? "Suspender cuenta" : "Reactivar cuenta"}
          message={pendingSuspension.action === "suspend"
            ? `¿Quieres suspender la cuenta de ${pendingSuspension.user.full_name}? Se bloquearán nuevos inicios de sesión.`
            : `¿Quieres reactivar la cuenta de ${pendingSuspension.user.full_name}? Podrá iniciar sesión nuevamente.`}
          detail={pendingSuspension.action === "suspend"
            ? "Las sesiones que ya estén abiertas no se cerrarán inmediatamente."
            : undefined}
          errorMessage={suspensionActionError}
          confirmLabel={pendingSuspension.action === "suspend" ? "Suspender cuenta" : "Reactivar cuenta"}
          confirmingLabel={pendingSuspension.action === "suspend" ? "Suspendiendo..." : "Reactivando..."}
          isConfirming={isSuspensionSaving}
          onCancel={() => {
            if (isSuspensionSaving) return;
            setPendingSuspension(null);
            setSuspensionActionError("");
          }}
          onConfirm={() => { void handleSuspensionConfirmation(); }}
        />
      )}
    </div>
  );
}

export default Usuarios;
