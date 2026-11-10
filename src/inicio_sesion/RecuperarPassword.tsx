import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { clearPasswordRecovery, storeRecoveryRequest } from "../auth/password-recovery";
import "./S-login.css";

function RecuperarPassword() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requestInProgress = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInProgress.current) return;

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Ingresa un correo electrónico válido.");
      return;
    }

    requestInProgress.current = true;
    setIsSubmitting(true);
    setError("");
    clearPasswordRecovery();

    try {
      const requestStartedAt = Date.now();
      const { error: requestError } = await supabase.auth.resetPasswordForEmail(email);
      if (requestError) {
        const isRateLimited = requestError.status === 429 || /rate|too many|limit/i.test(requestError.message);
        setError(isRateLimited
          ? "Se alcanzó el límite de solicitudes. Espera un momento antes de intentarlo de nuevo."
          : "No se pudo procesar la solicitud. Revisa el correo e inténtalo nuevamente.");
        return;
      }

      storeRecoveryRequest(email, requestStartedAt);
      navigate("/verificar-codigo", { replace: true });
    } catch {
      setError("Ocurrió un error al solicitar la recuperación. Inténtalo nuevamente.");
    } finally {
      requestInProgress.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Recuperar contraseña</p>
        <p className="texto-ayuda">No te preocupes. Escribe tu correo y te enviaremos instrucciones para recuperar el acceso.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="correo">Correo electrónico</label>
          <input id="correo" type="email" name="email" placeholder="Ingrese su correo" autoComplete="email" required />
          {error && <p className="login-mensaje login-error" role="alert">{error}</p>}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Enviando..." : "Continuar"}
          </button>
        </form>

        <Link to="/">Volver al inicio de sesión</Link>
      </div>
    </div>
  );
}

export default RecuperarPassword;