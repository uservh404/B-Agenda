import { useState, type FormEvent } from "react";
import "./S-login.css";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth/useAuth";
/* Link = enlace.
Permite navegar entre pantallas sin recargar la aplicación. */

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshAuth } = useAuth();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const authMessage = (location.state as { authMessage?: string } | null)?.authMessage;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    setError("");
    setIsSubmitting(true);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        if (signInError.code === "user_banned") {
          setError("Cuenta suspendida. Comunícate con el administrador para solicitar su reactivación.");
        } else if (signInError.code === "email_not_confirmed") {
          setError("Confirma tu correo electrónico antes de iniciar sesión.");
        } else {
          setError("Correo o contraseña incorrectos. Verifica tus datos e inténtalo nuevamente.");
        }
        return;
      }

      if (!data.session || !data.user) {
        setError("Correo o contraseña incorrectos. Verifica tus datos e inténtalo nuevamente.");
        return;
      }

      if (!data.user.email_confirmed_at) {
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        setError(signOutError
          ? "Confirma tu correo electrónico. No se pudo cerrar la sesión automáticamente; vuelve a intentarlo."
          : "Confirma tu correo electrónico antes de iniciar sesión.");
        return;
      }

      const authResult = await refreshAuth();
      if (authResult.status === "offline") {
        setError("Se inició la sesión, pero no podemos comprobar tu acceso sin conexión. Se conservará y volveremos a verificarlo cuando regrese Internet.");
        return;
      }
      if (authResult.status !== "authenticated" || !authResult.profile) {
        setError(authResult.error ?? "No se pudo validar el perfil de tu cuenta. El acceso permanece bloqueado.");
        return;
      }

      navigate("/principal", { replace: true });
    } catch {
      setError("Ocurrió un error al iniciar sesión. Inténtalo nuevamente.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Inicio de sesión</p>
        {authMessage && <p className="login-mensaje login-exito" role="status">{authMessage}</p>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="login-email">Correo electrónico</label>
          <input id="login-email" type="email" name="email" placeholder="Ingrese su correo electrónico" autoComplete="email" required />

          <label htmlFor="login-password">Contraseña</label>
          <input id="login-password" type="password" name="password" placeholder="Ingrese su contraseña" autoComplete="current-password" required />

          {error && <p className="login-mensaje login-error" role="alert">{error}</p>}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Iniciando sesión..." : "Iniciar sesión"}
          </button>
        </form>
        <Link to="/recuperar-password">¿Olvidaste la contraseña?</Link>
        <p className="registro-prompt">¿Aún no tienes una cuenta?</p>
        <Link to="/registro">Registrar usuario</Link>
      </div>
    </div>
  );
}

export default Login; /* exporta la función Login para poder usarla en otros archivos */
