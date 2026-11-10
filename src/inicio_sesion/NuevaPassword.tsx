import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth/useAuth";
import { clearPasswordRecovery, getVerifiedRecoveryUser } from "../auth/password-recovery";
import "./S-login.css";

function NuevaPassword() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    const verifiedUserId = getVerifiedRecoveryUser();

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;

      if (!sessionError && data.session?.user.id && data.session.user.id === verifiedUserId) {
        setIsAuthorized(true);
      } else {
        clearPasswordRecovery();
        setError(sessionError
          ? "No se pudo comprobar la sesión de recuperación. Solicita un nuevo código."
          : "Primero debes verificar el código enviado a tu correo.");
      }
      setIsChecking(false);
    }).catch(() => {
      if (!active) return;
      clearPasswordRecovery();
      setError("No se pudo comprobar la sesión de recuperación. Solicita un nuevo código.");
      setIsChecking(false);
    });

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isAuthorized || isSubmitting) return;

    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    const confirmation = String(formData.get("confirmation") ?? "");

    if (password.length < 8) {
      setError("La contraseña debe tener al menos ocho caracteres.");
      return;
    }
    if (password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setError("");
    setSuccess("");
    setIsSubmitting(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError("No se pudo actualizar la contraseña. Inténtalo nuevamente.");
        return;
      }

      const signOutError = await signOut();
      if (signOutError) {
        setIsAuthorized(false);
        setSuccess("La contraseña se actualizó correctamente.");
        setError("No se pudo cerrar la sesión de recuperación. Cierra la sesión antes de volver a iniciar.");
        return;
      }

      clearPasswordRecovery();
      navigate("/", {
        replace: true,
        state: { authMessage: "Tu contraseña se actualizó correctamente. Inicia sesión con tu nueva contraseña." },
      });
    } catch {
      setError("Ocurrió un error al actualizar la contraseña. Inténtalo nuevamente.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isChecking && !isAuthorized) {
    return (
      <div className="contenedor">
        <div className="login">
          <h1>Biblioteca digital</h1>
          <p>Nueva contraseña</p>
          {error && <p className="login-mensaje login-error" role="alert">{error}</p>}
          <Link to="/recuperar-password">Solicitar un nuevo código</Link>
          <Link to="/">Volver al inicio de sesión</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Nueva contraseña</p>
        <p className="texto-ayuda">
          {isChecking
            ? "Comprobando la sesión de recuperación..."
            : "Crea una contraseña nueva para volver a entrar a tu biblioteca digital."}
        </p>
        {error && <p className="login-mensaje login-error" role="alert">{error}</p>}
        {success && <p className="login-mensaje login-exito" role="status">{success}</p>}

        {isAuthorized && <form onSubmit={handleSubmit}>
          <label htmlFor="nueva-password">Nueva contraseña</label>
          <input id="nueva-password" type="password" name="password" placeholder="Ingrese su nueva contraseña" minLength={8} autoComplete="new-password" required />

          <label htmlFor="confirmar-password">Confirmar contraseña</label>
          <input id="confirmar-password" type="password" name="confirmation" placeholder="Confirme su contraseña" minLength={8} autoComplete="new-password" required />

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Guardando..." : "Guardar contraseña"}
          </button>
        </form>}

        <Link to="/">Volver al inicio de sesión</Link>
      </div>
    </div>
  );
}

export default NuevaPassword;