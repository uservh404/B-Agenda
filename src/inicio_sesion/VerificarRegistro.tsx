import { useEffect, useRef, useState } from "react";
import type { FormEvent, ClipboardEvent, KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import "./S-login.css";

const CODE_TTL_MS = 5 * 60 * 1000;
const EMAIL_STORAGE_KEY = "biblioteca-signup-email";
const EXPIRY_STORAGE_KEY = "biblioteca-signup-code-expires-at";

function getStoredExpiry(): number {
  const storedExpiry = Number(sessionStorage.getItem(EXPIRY_STORAGE_KEY));
  return Number.isFinite(storedExpiry) && storedExpiry > 0 ? storedExpiry : 0;
}

function getRemainingSeconds(expiry: number): number {
  return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
}

function VerificarRegistro() {
  const location = useLocation();
  const navigate = useNavigate();
  const sessionEmail = sessionStorage.getItem(EMAIL_STORAGE_KEY);
  const correo = (location.state as { correo?: string } | null)?.correo ?? sessionEmail ?? "";
  const [codigo, setCodigo] = useState<string[]>(Array(6).fill(""));
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [expiresAt, setExpiresAt] = useState(getStoredExpiry);
  const [remainingSeconds, setRemainingSeconds] = useState(() => getRemainingSeconds(getStoredExpiry()));
  const codeInputs = useRef<(HTMLInputElement | null)[]>([]);
  const resendInProgress = useRef(false);
  const missingCorreoMessage = !correo ? "No se encontró el correo para verificar la cuenta. Vuelve al registro." : "";
  const isExpired = remainingSeconds === 0;

  useEffect(() => {
    if (!expiresAt || isExpired) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRemainingSeconds(getRemainingSeconds(expiresAt));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [expiresAt, isExpired]);

  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!correo) {
      setError("No se encontró el correo para verificar la cuenta. Vuelve al registro.");
      return;
    }

    const codigoCompleto = codigo.join("");
    if (!/^\d{6}$/.test(codigoCompleto)) {
      setError("El código debe contener exactamente 6 dígitos.");
      return;
    }

    setError("");
    setSuccess("");
    setIsSubmitting(true);

    const { error: otpError } = await supabase.auth.verifyOtp({
      email: correo,
      token: codigoCompleto,
      type: "signup",
    });

    if (otpError) {
      setError("El código es incorrecto, ha caducado o no se pudo validar. Inténtalo nuevamente.");
      setIsSubmitting(false);
      return;
    }

    sessionStorage.removeItem(EMAIL_STORAGE_KEY);
    sessionStorage.removeItem(EXPIRY_STORAGE_KEY);
    setSuccess("Registro verificado correctamente. Redirigiendo al inicio de sesión...");
    setIsSubmitting(false);
    navigate("/", { replace: true });
  }

  async function handleResendCode() {
    if (resendInProgress.current || isResending) {
      return;
    }

    if (!correo) {
      setError("No se encontró el correo para reenviar el código.");
      return;
    }

    setError("");
    setSuccess("");
    resendInProgress.current = true;
    setIsResending(true);

    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: correo,
      });

      if (resendError) {
        const isRateLimited = /rate|too many|seconds|limit/i.test(resendError.message);
        setError(isRateLimited
          ? "No puedes solicitar otro código todavía. Espera un momento e inténtalo nuevamente."
          : "No se pudo reenviar el código. Inténtalo nuevamente más tarde.");
        return;
      }

      const newExpiry = Date.now() + CODE_TTL_MS;
      sessionStorage.setItem(EXPIRY_STORAGE_KEY, String(newExpiry));
      setExpiresAt(newExpiry);
      setRemainingSeconds(getRemainingSeconds(newExpiry));
      setSuccess("Se ha solicitado un nuevo código para tu correo.");
      setCodigo(Array(6).fill(""));
      codeInputs.current[0]?.focus();
    } catch {
      setError("Ocurrió un error al reenviar el código. Inténtalo nuevamente.");
    } finally {
      resendInProgress.current = false;
      setIsResending(false);
    }
  }

  function handleCodeChange(index: number, value: string) {
    const digits = value.replace(/\D/g, "");
    if (!digits) {
      const nextCode = [...codigo];
      nextCode[index] = "";
      setCodigo(nextCode);
      return;
    }

    const nextCode = [...codigo];
    for (const [offset, digit] of [...digits].entries()) {
      const targetIndex = index + offset;
      if (targetIndex > 5) break;
      nextCode[targetIndex] = digit;
    }
    setCodigo(nextCode);
    codeInputs.current[Math.min(index + digits.length, 5)]?.focus();
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

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Confirma tu registro</p>
        <p className="texto-ayuda">
          Ingresa el código de 6 dígitos para confirmar la creación de tu cuenta.
        </p>
        {correo && <p className="texto-ayuda">Correo: {correo}</p>}

        {missingCorreoMessage && <p className="login-mensaje login-error" role="alert">{missingCorreoMessage}</p>}
        {error && <p className="login-mensaje login-error" role="alert">{error}</p>}
        {success && <p className="login-mensaje login-exito">{success}</p>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="codigo-0">Código de verificación</label>
          <div className="code-inputs" aria-label="Código de 6 dígitos">
            {codigo.map((digit, index) => (
              <input
                key={index}
                id={index === 0 ? "codigo-0" : undefined}
                ref={(element) => { codeInputs.current[index] = element; }}
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
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
              Tu código ha caducado. Solicita uno nuevo.
            </p>
          )}
          <button type="submit" disabled={isSubmitting || !correo || isExpired}>
            {isSubmitting ? "Verificando..." : "Confirmar registro"}
          </button>
        </form>

        <button type="button" className="login-link-button" onClick={handleResendCode} disabled={isResending || !correo}>
          {isResending ? "Enviando..." : "Reenviar código"}
        </button>

        <Link to="/registro">Volver al registro</Link>
      </div>
    </div>
  );
}

export default VerificarRegistro;
