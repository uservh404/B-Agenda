import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent, KeyboardEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth/useAuth";
import {
  getRecoveryEmail,
  getRecoveryExpiry,
  getRecoveryResendAt,
  PASSWORD_RECOVERY_RESEND_COOLDOWN_MS,
  PASSWORD_RECOVERY_TTL_MS,
  storeRecoveryRequest,
  storeRecoveryResendAt,
  storeVerifiedRecoveryUser,
} from "../auth/password-recovery";
import "./S-login.css";

function getRemainingSeconds(timestamp: number): number {
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function VerificarCodigo() {
  const navigate = useNavigate();
  const { refreshAuth } = useAuth();
  const correo = getRecoveryEmail();
  const [codigo, setCodigo] = useState<string[]>(Array(6).fill(""));
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [expiresAt, setExpiresAt] = useState(getRecoveryExpiry);
  const [resendAt, setResendAt] = useState(getRecoveryResendAt);
  const [remainingSeconds, setRemainingSeconds] = useState(() => getRemainingSeconds(getRecoveryExpiry()));
  const [resendSeconds, setResendSeconds] = useState(() => getRemainingSeconds(getRecoveryResendAt()));
  const codeInputs = useRef<(HTMLInputElement | null)[]>([]);
  const requestInProgress = useRef(false);
  const hasRequest = expiresAt > 0;
  const isExpired = hasRequest && remainingSeconds === 0;

  useEffect(() => {
    if (getRemainingSeconds(expiresAt) === 0 && getRemainingSeconds(resendAt) === 0) return;

    const intervalId = window.setInterval(() => {
      const nextRemainingSeconds = getRemainingSeconds(expiresAt);
      const nextResendSeconds = getRemainingSeconds(resendAt);
      setRemainingSeconds(nextRemainingSeconds);
      setResendSeconds(nextResendSeconds);
      if (nextRemainingSeconds === 0 && nextResendSeconds === 0) {
        window.clearInterval(intervalId);
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [expiresAt, resendAt]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    if (!correo) {
      setError("No se encontró una solicitud de recuperación. Vuelve a solicitar el código.");
      return;
    }

    const token = codigo.join("");
    if (!/^\d{6}$/.test(token)) {
      setError("El código debe contener exactamente seis dígitos.");
      return;
    }

    setError("");
    setSuccess("");
    setIsSubmitting(true);

    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        email: correo,
        token,
        type: "recovery",
      });

      if (verifyError || !data.session || !data.user) {
        setError("El código es incorrecto, ha caducado o no se pudo validar. Solicita otro código e inténtalo de nuevo.");
        return;
      }

      storeVerifiedRecoveryUser(data.user.id);
      const authResult = await refreshAuth();
      if (authResult.status !== "recovery" || authResult.user?.id !== data.user.id) {
        setError("No se pudo confirmar la sesión de recuperación. Solicita un nuevo código.");
        return;
      }

      navigate("/nueva-password", { replace: true });
    } catch {
      setError("Ocurrió un error al validar el código. Inténtalo nuevamente.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResendCode() {
    if (requestInProgress.current || isResending || resendSeconds > 0) return;
    if (!correo) {
      setError("No se encontró el correo de recuperación. Vuelve a solicitar el código.");
      return;
    }

    requestInProgress.current = true;
    setIsResending(true);
    setError("");
    setSuccess("");

    const requestStartedAt = Date.now();
    const nextResendAt = Date.now() + PASSWORD_RECOVERY_RESEND_COOLDOWN_MS;
    storeRecoveryResendAt(nextResendAt);
    setResendAt(nextResendAt);
    setResendSeconds(getRemainingSeconds(nextResendAt));

    try {
      const { error: resendError } = await supabase.auth.resetPasswordForEmail(correo);
      if (resendError) {
        const isRateLimited = resendError.status === 429 || /rate|too many|limit/i.test(resendError.message);
        setError(isRateLimited
          ? "Supabase limitó los reenvíos. Espera antes de volver a intentarlo."
          : "No se pudo reenviar el código. Inténtalo nuevamente más tarde.");
        return;
      }

      const now = Date.now();
      storeRecoveryRequest(correo, requestStartedAt, now);
      setExpiresAt(requestStartedAt + PASSWORD_RECOVERY_TTL_MS);
      setResendAt(now + PASSWORD_RECOVERY_RESEND_COOLDOWN_MS);
      setRemainingSeconds(getRemainingSeconds(requestStartedAt + PASSWORD_RECOVERY_TTL_MS));
      setResendSeconds(getRemainingSeconds(now + PASSWORD_RECOVERY_RESEND_COOLDOWN_MS));
      setCodigo(Array(6).fill(""));
      setSuccess("Si el correo está asociado a una cuenta, recibirás un nuevo código.");
      codeInputs.current[0]?.focus();
    } catch {
      setError("Ocurrió un error al reenviar el código. Inténtalo nuevamente.");
    } finally {
      requestInProgress.current = false;
      setIsResending(false);
    }
  }

  function handleCodeChange(index: number, value: string) {
    const digits = value.replace(/\D/g, "");
    const nextCode = [...codigo];
    if (digits.length > 1) {
      for (const [offset, digit] of [...digits].entries()) {
        if (index + offset > 5) break;
        nextCode[index + offset] = digit;
      }
      setCodigo(nextCode);
      codeInputs.current[Math.min(index + digits.length, 5)]?.focus();
      return;
    }

    nextCode[index] = digits;
    setCodigo(nextCode);

    if (digits && index < 5) {
      codeInputs.current[index + 1]?.focus();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const nextCode = Array(6).fill("");
    [...digits].forEach((digit, index) => {
      nextCode[index] = digit;
    });
    setCodigo(nextCode);
    codeInputs.current[Math.min(digits.length, 5)]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !codigo[index] && index > 0) {
      codeInputs.current[index - 1]?.focus();
    }
  }

  if (!correo) {
    return <Navigate to="/recuperar-password" replace />;
  }

  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
  const resendMinutes = Math.floor(resendSeconds / 60).toString().padStart(2, "0");
  const resendRemainder = (resendSeconds % 60).toString().padStart(2, "0");

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Verificar código</p>
        <p className="texto-ayuda">Revisa tu correo e introduce el código de 6 dígitos que te enviamos.</p>
        <p className="texto-ayuda">Correo: {correo}</p>

        {!success && (
          <p className="login-mensaje login-exito" role="status">
            Si el correo está asociado a una cuenta, recibirás un código para recuperar el acceso.
          </p>
        )}
        {error && <p className="login-mensaje login-error" role="alert">{error}</p>}
        {success && <p className="login-mensaje login-exito" role="status">{success}</p>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="recovery-code-0">Código de verificación</label>
          <div className="code-inputs" aria-label="Código de 6 dígitos">
            {codigo.map((digit, index) => (
              <input
                key={index}
                id={index === 0 ? "recovery-code-0" : undefined}
                ref={(element) => { codeInputs.current[index] = element; }}
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                pattern="[0-9]"
                maxLength={1}
                value={digit}
                onChange={(event) => handleCodeChange(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={handlePaste}
                aria-label={`Dígito ${index + 1} de 6`}
                required
              />
            ))}
          </div>
          <p className="verification-countdown" aria-live="polite">
            Tiempo restante: <strong>{minutes}:{seconds}</strong>
          </p>
          {isExpired && (
            <p className="login-mensaje login-error verification-expired" role="alert">
              Tu código ha caducado. Solicita uno nuevo
            </p>
          )}
          {!hasRequest && <p className="login-mensaje login-error" role="alert">No se encontró una solicitud activa para este código.</p>}
          <button type="submit" disabled={isSubmitting || !hasRequest || isExpired}>
            {isSubmitting ? "Verificando..." : "Verificar código"}
          </button>
        </form>

        <button
          type="button"
          className="login-link-button"
          onClick={() => { void handleResendCode(); }}
          disabled={isResending || resendSeconds > 0}
        >
          {isResending
            ? "Enviando..."
            : resendSeconds > 0
              ? `Reenviar código (${resendMinutes}:${resendRemainder})`
              : "Reenviar código"}
        </button>

        <Link to="/recuperar-password">Volver</Link>
      </div>
    </div>
  );
}

export default VerificarCodigo;