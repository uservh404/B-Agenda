import { useState, type FormEvent } from "react";
import { MailCheck, UserRound } from "lucide-react";
import Sidebar from "../components/Sidebar";
import { getActiveUserId, setActiveUser } from "../auth/permissions";
import { readUsers, saveUsers } from "../auth/users";
import { appThemes, getAppTheme, saveAppTheme, type AppTheme } from "../theme";
import "./S-principal.css";
import "./S-configuracion.css";

interface ProfileData {
  name: string;
  email: string;
  phone: string;
}

function Configuracion() {
  const [registeredUsers, setRegisteredUsers] = useState(readUsers);
  const [activeUserId, setActiveUserId] = useState(getActiveUserId);
  const activeUser = registeredUsers.find((user) => user.id === activeUserId) ?? registeredUsers[0];
  const [savedName, setSavedName] = useState(activeUser.name);
  const [draftName, setDraftName] = useState(activeUser.name);
  const [savedEmail, setSavedEmail] = useState(activeUser.email);
  const [draftEmail, setDraftEmail] = useState(activeUser.email);
  const [savedPhone, setSavedPhone] = useState(activeUser.phone);
  const [draftPhone, setDraftPhone] = useState(activeUser.phone);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<AppTheme>(getAppTheme);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationNotice, setVerificationNotice] = useState("");

  const saveProfile = () => {
    const updatedProfile: ProfileData = {
      name: draftName.trim(),
      email: draftEmail.trim(),
      phone: draftPhone.trim(),
    };

    const updatedUsers = registeredUsers.map((user) =>
      user.id === activeUser.id ? { ...user, ...updatedProfile } : user,
    );
    setRegisteredUsers(updatedUsers);
    saveUsers(updatedUsers);
    setSavedName(updatedProfile.name);
    setSavedEmail(updatedProfile.email);
    setSavedPhone(updatedProfile.phone);
    setEditing(false);
    setSaved(true);
    setVerificationOpen(false);
    setVerificationCode("");
    setVerificationNotice("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVerificationCode("");
    setVerificationNotice("");
    setVerificationOpen(true);
  };

  const handleVerificationSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (verificationCode.length !== 6) {
      setVerificationNotice("Escribe los seis dígitos para continuar con la vista previa.");
      return;
    }
    saveProfile();
  };

  const handleCancel = () => {
    setDraftName(savedName);
    setDraftEmail(savedEmail);
    setDraftPhone(savedPhone);
    setEditing(false);
    setSaved(false);
    setVerificationOpen(false);
    setVerificationCode("");
    setVerificationNotice("");
  };

  const handleActiveUserChange = (userId: number) => {
    const selectedUser = registeredUsers.find((user) => user.id === userId);
    if (!selectedUser) return;
    setActiveUserId(userId);
    setActiveUser(userId, selectedUser.role === "Empleado" ? "empleado" : "administrador");
    window.location.reload();
  };

  const handleThemeChange = (theme: AppTheme) => {
    setSelectedTheme(theme);
    saveAppTheme(theme);
  };

  return (
    <div className="dashboard settings-page">
      <Sidebar />

      <main className="content settings-content">
        <header className="content-header settings-header">
          <span className="settings-eyebrow">Preferencias de cuenta</span>
          <h1>Configuración</h1>
          <p>Administra tus datos personales y mantén actualizada tu información.</p>
        </header>

        <section className="settings-panel">
          {verificationOpen ? (
            <section className="profile-verification" aria-labelledby="profile-verification-title">
              <div className="profile-verification-icon" aria-hidden="true"><MailCheck size={30} strokeWidth={1.8} /></div>
              <span className="settings-eyebrow">Verificación de correo</span>
              <h2 id="profile-verification-title">Confirma tus cambios</h2>
              <p>Te enviamos un código de verificación a:</p>
              <strong className="profile-verification-email">{draftEmail}</strong>

              <form className="profile-verification-form" onSubmit={handleVerificationSubmit}>
                <label htmlFor="profile-verification-code">Código de verificación</label>
                <input
                  id="profile-verification-code"
                  className="profile-verification-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={verificationCode}
                  onChange={(event) => {
                    setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setVerificationNotice("");
                  }}
                  aria-describedby="profile-verification-note"
                />
                <p id="profile-verification-note" className="profile-verification-note">
                  Revisa tu bandeja de entrada o la carpeta de spam. Ingresa el código de seis dígitos para confirmar los cambios.
                </p>
                {verificationNotice && <p className="profile-verification-notice" role="status">{verificationNotice}</p>}
                <div className="profile-verification-actions">
                  <button type="button" className="profile-verification-back" onClick={() => { setVerificationOpen(false); setVerificationNotice(""); }}>
                    Volver a editar
                  </button>
                  <button type="submit" className="profile-verification-continue" disabled={verificationCode.length !== 6}>
                    Continuar
                  </button>
                </div>
              </form>
            </section>
          ) : (
          <>
          <div className="profile-summary">
            <div className="profile-icon" aria-hidden="true"><UserRound size={42} strokeWidth={1.8} /></div>
            <div className="profile-info">
              <span className="settings-eyebrow">Mi perfil</span>
              <div className="profile-name-line">
                <h2>{savedName}</h2>
                <button type="button" className="edit-profile-button" onClick={() => { setEditing(true); setSaved(false); }} aria-label="Editar datos del perfil" title="Editar perfil">✎</button>
              </div>
              <p>{savedEmail}</p>
              <span className="profile-role">{activeUser.role}</span>
            </div>
          </div>

          <div className="profile-divider" />
          <p className="profile-note">Mantén tus datos actualizados para identificarte correctamente dentro de la biblioteca.</p>

          {editing && (
            <form className="settings-form" onSubmit={handleSubmit}>
              <div className="settings-form-heading">
              <div>
                <span className="settings-eyebrow">Editar perfil</span>
                <h2>Actualizar datos</h2>
              </div>
              <span className="settings-panel-icon">✎</span>
              </div>

              <label htmlFor="settings-name">Nombre de usuario</label>
              <input
                id="settings-name"
                type="text"
                value={draftName}
                onChange={(event) => { setDraftName(event.target.value); setSaved(false); }}
                required
              />

              <label htmlFor="settings-email">Correo electrónico</label>
              <input id="settings-email" type="email" value={draftEmail} onChange={(event) => { setDraftEmail(event.target.value); setSaved(false); }} required />

              <label htmlFor="settings-phone">Número telefónico</label>
              <input id="settings-phone" type="tel" value={draftPhone} onChange={(event) => { setDraftPhone(event.target.value); setSaved(false); }} required />

              <div className="settings-form-actions">
                <button type="button" className="cancel-settings-button" onClick={handleCancel}>Cancelar</button>
                <button type="submit">Guardar</button>
              </div>
            </form>
          )}
          {saved && <p className="settings-success" role="status">Tus datos se actualizaron correctamente.</p>}

          <section className="theme-settings" aria-labelledby="theme-settings-title">
            <div className="theme-settings-heading">
              <div>
                <span className="settings-eyebrow">Apariencia</span>
                <h2 id="theme-settings-title">Tema de la aplicación</h2>
                <p>Elige una combinación cómoda para tus pantallas.</p>
              </div>
            </div>
            <div className="theme-options" role="group" aria-label="Seleccionar tema">
              {appThemes.map((theme) => (
                <button
                  className={`theme-option ${selectedTheme === theme.id ? "selected" : ""}`}
                  type="button"
                  key={theme.id}
                  aria-pressed={selectedTheme === theme.id}
                  onClick={() => handleThemeChange(theme.id)}
                >
                  <span className={`theme-swatch theme-swatch-${theme.id}`} aria-hidden="true" />
                  <span className="theme-option-copy">
                    <strong>{theme.name}</strong>
                    <small>{theme.description}</small>
                  </span>
                  <span className="theme-option-check" aria-hidden="true">{selectedTheme === theme.id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          </section>

          <div className="temporary-role-settings">
            <div>
              <span className="settings-eyebrow">Prueba temporal</span>
              <h2>Cuenta activa</h2>
              <p>Selecciona una cuenta para probar sus permisos dentro de la aplicación.</p>
            </div>
            <label htmlFor="active-user">Usuario</label>
            <select id="active-user" value={activeUserId} onChange={(event) => handleActiveUserChange(Number(event.target.value))}>
              {registeredUsers.map((user) => (
                <option key={user.id} value={user.id}>{user.name} · {user.role}</option>
              ))}
            </select>
          </div>
          </>
          )}
        </section>
      </main>
    </div>
  );
}

export default Configuracion;