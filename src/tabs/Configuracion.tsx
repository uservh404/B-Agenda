import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LoaderCircle, LogOut, MailCheck, UserRound, X } from "lucide-react";
import Sidebar from "../components/Sidebar";
import { useAuth } from "../auth/useAuth";
import { supabase } from "../lib/supabaseClient";
import type {
  ProfileSettingsOperation,
  ProfileVerificationChallenge,
  ProfileVerificationErrorCode,
} from "../services/profile-settings-verification";
import { appThemes, getAppTheme, saveAppTheme, type AppTheme } from "../theme";
import "./S-principal.css";
import "./S-configuracion.css";

type ProfileField = "name" | "email" | "phone";
type ProfileErrors = Partial<Record<ProfileField, string>>;
type VerificationWaitCode = Extract<ProfileVerificationErrorCode, "rate_limited" | "resend_cooldown">;
type EmailChangeStage = "current" | "new";
type EmailChangeFlow = {
  currentEmail: string;
  newEmail: string;
  stage: EmailChangeStage;
};
type PendingEmailState = { userId: string; email: string };
type PendingEmailCheck = { userId: string; newEmail: string };

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function validateName(value: string) {
  if (!value) return "El nombre completo es obligatorio.";
  if (value.length < 2 || value.length > 100) return "Usa entre 2 y 100 caracteres.";
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(value)) {
    return "Usa letras, espacios, apóstrofes, puntos o guiones.";
  }
  return "";
}

function emptyVerificationCode() {
  return Array.from({ length: 6 }, () => "");
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name.slice(0, 1)}•••@${domain}`;
}

function getRetryAtTimestamp(retryAt?: string, retryAfterSeconds?: number) {
  const serverTimestamp = retryAt ? Date.parse(retryAt) : NaN;
  if (Number.isFinite(serverTimestamp)) return serverTimestamp;
  return retryAfterSeconds && retryAfterSeconds > 0
    ? Date.now() + retryAfterSeconds * 1000
    : 0;
}

function normalizePhone(value: string): string | null {
  const trimmedPhone = value.trim();
  if (!trimmedPhone) return null;
  if (!/^[+\d\s().-]+$/.test(trimmedPhone)) return null;

  const compactPhone = trimmedPhone.replace(/[\s().-]/g, "");
  const nationalNumber = compactPhone.startsWith("+52")
    ? compactPhone.slice(3)
    : compactPhone;

  if (!/^\d{10}$/.test(nationalNumber)) return null;
  return `+52${nationalNumber}`;
}

function getEmailError(error: { code?: string; message: string }) {
  const message = error.message.toLowerCase();
  if (error.code === "email_address_invalid" || message.includes("invalid email")) {
    return "Escribe un correo electrónico válido.";
  }
  if (error.code === "email_exists" || message.includes("already been registered") || message.includes("already exists")) {
    return "Ese correo ya está asociado a otra cuenta.";
  }
  if (error.code === "reauthentication_needed") {
    return "Por seguridad, vuelve a iniciar sesión antes de cambiar el correo.";
  }
  if (error.code === "over_email_send_rate_limit") {
    return "Se alcanzó el límite de correos. Espera un momento e inténtalo nuevamente.";
  }
  if (error.code === "email_change_pending") {
    return "Ya hay un cambio de correo pendiente. Confirma los códigos enviados antes de iniciar otro.";
  }
  return "No se pudo iniciar el cambio de correo. Revisa la dirección e inténtalo nuevamente.";
}

function getEmailErrorFromUnknown(error: unknown) {
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
  ) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return getEmailError({ code, message: error.message });
  }
  return "No se pudo iniciar el cambio de correo. Revisa la dirección e inténtalo nuevamente.";
}

function getEmailVerificationError(error: { code?: string; message: string }) {
  if (/failed to fetch|network|timeout/i.test(error.message)) {
    return "No se pudo comprobar el código. Revisa tu conexión e inténtalo nuevamente.";
  }
  if (error.code === "email_exists") {
    return "Ese correo ya está asociado a otra cuenta.";
  }
  return "El código no es válido o venció. Revisa los seis dígitos e inténtalo nuevamente.";
}

function getVerificationError(code: ProfileVerificationErrorCode, retryAfterSeconds = 0) {
  switch (code) {
    case "already_used":
      return "Este código ya fue utilizado. Solicita uno nuevo para continuar.";
    case "code_invalid":
      return "El código no es correcto. Revisa el mensaje e inténtalo nuevamente.";
    case "email_change_pending":
      return "Ya hay un cambio de correo pendiente. Complétalo o espera a que expire antes de iniciar otro.";
    case "email_delivery_failed":
      return "No se pudo enviar el código. Espera un momento e inténtalo nuevamente.";
    case "email_not_verified":
      return "La cuenta no tiene un correo confirmado. Confírmalo antes de cambiar tus datos.";
    case "expired":
      return "El código venció. Solicita uno nuevo para continuar.";
    case "invalid_challenge":
      return "La solicitud de verificación ya no es válida. Solicita un código nuevo.";
    case "invalid_input":
      return "Revisa los datos del formulario e inténtalo nuevamente.";
    case "network_error":
      return "No se pudo contactar al servicio de verificación. Comprueba tu conexión e inténtalo nuevamente.";
    case "no_changes":
      return "No hay cambios para guardar.";
    case "rate_limited":
      return `Has solicitado varios códigos. Por seguridad, podrás solicitar otro en ${formatCountdown(retryAfterSeconds)}.`;
    case "resend_cooldown":
      return `Solicitaste un código recientemente. Para volver a intentarlo, espera ${formatCountdown(retryAfterSeconds)}.`;
    case "too_many_attempts":
      return "Se agotaron los intentos para este código. Solicita uno nuevo.";
    default:
      return "No se pudo completar la verificación. Inténtalo nuevamente.";
  }
}

function Configuracion() {
  const navigate = useNavigate();
  const {
    profile,
    user,
    status,
    requestProfileSettingsVerification,
    verifyAndApplyProfileSettings,
    cancelProfileSettingsVerification,
    refreshAuth,
    signOut,
  } = useAuth();
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const [editing, setEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [draftPhone, setDraftPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<ProfileErrors>({});
  const [formError, setFormError] = useState("");
  const [requestLimitCode, setRequestLimitCode] = useState<VerificationWaitCode | null>(null);
  const [requestRetryAt, setRequestRetryAt] = useState(0);
  const [requestRetryRemainingSeconds, setRequestRetryRemainingSeconds] = useState(0);
  const [profileNotice, setProfileNotice] = useState("");
  const [pendingEmailState, setPendingEmailState] = useState<PendingEmailState | null>(null);
  const [serverPendingEmailState, setServerPendingEmailState] = useState<PendingEmailState | null>(null);
  const [pendingEmailCheck, setPendingEmailCheck] = useState<PendingEmailCheck | null>(null);
  const [isCheckingPendingEmail, setIsCheckingPendingEmail] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<ProfileSettingsOperation | null>(null);
  const [verificationChallenge, setVerificationChallenge] = useState<ProfileVerificationChallenge | null>(null);
  const [emailChangeFlow, setEmailChangeFlow] = useState<EmailChangeFlow | null>(null);
  const [verificationCode, setVerificationCode] = useState<string[]>(emptyVerificationCode);
  const [verificationError, setVerificationError] = useState("");
  const [verificationLimitCode, setVerificationLimitCode] = useState<VerificationWaitCode | null>(null);
  const [verificationNotice, setVerificationNotice] = useState("");
  const [verificationExpiresAt, setVerificationExpiresAt] = useState(0);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [verificationRemainingSeconds, setVerificationRemainingSeconds] = useState(0);
  const [resendRemainingSeconds, setResendRemainingSeconds] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<AppTheme>(getAppTheme);
  const verificationCodeInputs = useRef<Array<HTMLInputElement | null>>([]);
  const saveInProgress = useRef(false);
  const resendInProgress = useRef(false);
  const verifyInProgress = useRef(false);
  const emailStateRevision = useRef(0);
  const isVerificationExpired = verificationChallenge !== null && verificationRemainingSeconds === 0;
  const verificationErrorMessage = verificationLimitCode
    ? getVerificationError(verificationLimitCode, resendRemainingSeconds)
    : verificationError;
  const emailChangeTarget = emailChangeFlow
    ? emailChangeFlow.stage === "current" ? emailChangeFlow.currentEmail : emailChangeFlow.newEmail
    : "";
  const hasThreeStepEmailChange = Boolean(pendingOperation?.newEmail || emailChangeFlow);
  const emailChangeStep = emailChangeFlow
    ? emailChangeFlow.stage === "current" ? 2 : 3
    : 1;
  const pendingEmail = pendingEmailState && pendingEmailState.userId === user?.id
    ? pendingEmailState.email
    : "";
  const serverPendingEmail = serverPendingEmailState && serverPendingEmailState.userId === user?.id
    ? serverPendingEmailState.email
    : null;

  const profileAvailable = status === "authenticated" && Boolean(profile && user);
  const changesAvailable = isOnline && profileAvailable;

  const handleCancelVerification = useCallback(async () => {
    if (isVerifying || isResending) return;
    if (verificationChallenge) {
      const cancelled = await cancelProfileSettingsVerification(verificationChallenge.challengeId);
      if (!cancelled) {
        setProfileNotice("No pudimos cancelar el código. Los cambios aún no se han aplicado y el código vencerá automáticamente.");
      }
    }
    setVerificationOpen(false);
    setVerificationChallenge(null);
    setPendingOperation(null);
    setVerificationCode(emptyVerificationCode());
    setVerificationError("");
    setVerificationLimitCode(null);
    setVerificationNotice("");
    setVerificationExpiresAt(0);
    setResendAvailableAt(0);
    setVerificationRemainingSeconds(0);
    setResendRemainingSeconds(0);
  }, [isVerifying, isResending, verificationChallenge, cancelProfileSettingsVerification]);

  useEffect(() => {
    if (!verificationOpen) return;

    const updateCountdowns = () => {
      setVerificationRemainingSeconds(
        Math.max(0, Math.ceil((verificationExpiresAt - Date.now()) / 1000)),
      );
      setResendRemainingSeconds(
        Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)),
      );
    };
    updateCountdowns();
    const intervalId = window.setInterval(updateCountdowns, 1000);
    return () => window.clearInterval(intervalId);
  }, [verificationOpen, verificationExpiresAt, resendAvailableAt]);

  useEffect(() => {
    if (!editing || !requestLimitCode || !requestRetryAt) return;

    const updateRetryCountdown = () => {
      const seconds = Math.max(0, Math.ceil((requestRetryAt - Date.now()) / 1000));
      setRequestRetryRemainingSeconds(seconds);
      setFormError(getVerificationError(requestLimitCode, seconds));
    };

    updateRetryCountdown();
    const intervalId = window.setInterval(updateRetryCountdown, 1000);
    return () => window.clearInterval(intervalId);
  }, [editing, requestLimitCode, requestRetryAt]);

  useEffect(() => {
    if (!verificationOpen) return;
    const frameId = window.requestAnimationFrame(() => verificationCodeInputs.current[0]?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [verificationOpen, verificationChallenge?.challengeId, emailChangeFlow?.stage]);

  useEffect(() => {
    const updateConnection = () => setIsOnline(window.navigator.onLine);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (status !== "authenticated" || !user?.id || !isOnline) return;

    const revision = emailStateRevision.current;
    void supabase.auth.getUser().then(({ data, error }) => {
      if (!active) return;
      if (revision !== emailStateRevision.current) return;
      if (error || !data.user || data.user.id !== user.id) {
        console.error("No se pudo comprobar el estado del cambio de correo.", {
          code: error?.code ?? "user_unavailable",
        });
        return;
      }
      const currentPendingEmail = data.user.new_email?.trim() ?? "";
      setServerPendingEmailState({ userId: user.id, email: currentPendingEmail });
      setPendingEmailState({ userId: user.id, email: currentPendingEmail });
      setPendingEmailCheck(null);
      if (!currentPendingEmail) setEmailChangeFlow(null);
    }).catch((error: unknown) => {
      if (active && revision === emailStateRevision.current) {
        console.error("No se pudo comprobar el estado del cambio de correo.", error);
      }
    });

    return () => {
      active = false;
    };
  }, [status, user?.id, user?.email, isOnline]);

  useEffect(() => {
    if (!editing && !verificationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSaving || isVerifying || isResending) return;
      if (verificationOpen) void handleCancelVerification();
      else setEditing(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editing, verificationOpen, isSaving, isVerifying, isResending, handleCancelVerification]);

  function openEditor() {
    if (!changesAvailable || !profile || !user) return;
    setDraftName(profile.full_name);
    setDraftEmail(user.email ?? "");
    setDraftPhone(profile.phone ?? "");
    setFieldErrors({});
    setFormError("");
    setRequestLimitCode(null);
    setRequestRetryAt(0);
    setRequestRetryRemainingSeconds(0);
    setProfileNotice("");
    setEditing(true);
  }

  function handleThemeChange(theme: AppTheme) {
    setSelectedTheme(theme);
    saveAppTheme(theme);
  }

  function applyVerificationChallenge(challenge: ProfileVerificationChallenge) {
    const expiresAt = Date.parse(challenge.expiresAt);
    const resendAt = Date.parse(challenge.resendAvailableAt);
    setVerificationChallenge(challenge);
    setVerificationExpiresAt(expiresAt);
    setResendAvailableAt(resendAt);
    setVerificationRemainingSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    setResendRemainingSeconds(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      saveInProgress.current
      || isSaving
      || requestRetryRemainingSeconds > 0
      || !profile
      || !user
    ) return;
    setRequestLimitCode(null);
    setRequestRetryAt(0);
    setRequestRetryRemainingSeconds(0);

    const fullName = normalizeName(draftName);
    const email = draftEmail.trim().toLowerCase();
    const phoneInputChanged = draftPhone.trim() !== (profile.phone ?? "").trim();
    const normalizedPhone = normalizePhone(draftPhone);
    const nextErrors: ProfileErrors = {};

    const nameError = validateName(fullName);
    if (nameError) nextErrors.name = nameError;
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      nextErrors.email = "Escribe un correo electrónico válido.";
    }
    if (phoneInputChanged && draftPhone.trim() && normalizedPhone === null) {
      nextErrors.phone = "Ingresa un teléfono mexicano de 10 dígitos, con o sin +52.";
    }

    setFieldErrors(nextErrors);
    setFormError("");
    if (Object.keys(nextErrors).length > 0) return;

    const phoneChanged = phoneInputChanged && (draftPhone.trim() === "" || normalizedPhone !== profile.phone);
    const phone = phoneChanged ? normalizedPhone : null;
    const emailChanged = email.toLowerCase() !== (user.email ?? "").trim().toLowerCase();
    const profileChanged = fullName !== profile.full_name || phoneChanged;
    if (!emailChanged && !profileChanged) {
      setFormError("No hay cambios para guardar.");
      return;
    }

    const operation: ProfileSettingsOperation = {
      fullName,
      phone,
      updatePhone: phoneChanged,
      updateProfile: profileChanged,
      newEmail: emailChanged ? email : null,
    };
    saveInProgress.current = true;
    setIsSaving(true);
    try {
      const request = await requestProfileSettingsVerification(operation);
      if (!request.ok) {
        if (request.code === "rate_limited" || request.code === "resend_cooldown") {
          const retryAt = getRetryAtTimestamp(request.retryAt, request.retryAfterSeconds);
          const retrySeconds = retryAt > 0
            ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
            : request.retryAfterSeconds ?? 0;
          if (retryAt > Date.now()) {
            setRequestLimitCode(request.code);
            setRequestRetryAt(retryAt);
            setRequestRetryRemainingSeconds(retrySeconds);
          }
          setFormError(getVerificationError(request.code, retrySeconds));
        } else {
          setFormError(getVerificationError(request.code, request.retryAfterSeconds));
        }
        return;
      }

      setRequestLimitCode(null);
      setRequestRetryAt(0);
      setRequestRetryRemainingSeconds(0);
      setPendingOperation(operation);
      applyVerificationChallenge(request.challenge);
      setVerificationCode(emptyVerificationCode());
      setVerificationError("");
      setVerificationNotice("");
      setEditing(false);
      setVerificationOpen(true);
    } catch (error) {
      console.error("No se pudo solicitar la verificación del perfil.", error);
      setFormError("No se pudo iniciar la verificación. Comprueba tu conexión e inténtalo nuevamente.");
    } finally {
      saveInProgress.current = false;
      setIsSaving(false);
    }
  }

  async function handleVerifyAndSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (emailChangeFlow) {
      if (verifyInProgress.current || verificationCode.join("").length !== 6) return;
      emailStateRevision.current += 1;
      verifyInProgress.current = true;
      setIsVerifying(true);
      setVerificationError("");
      setVerificationNotice("");
      try {
        const { data, error } = await supabase.auth.verifyOtp({
          email: emailChangeTarget,
          token: verificationCode.join(""),
          type: "email_change",
        });
        if (error) {
          setVerificationError(getEmailVerificationError(error));
          return;
        }

        if (emailChangeFlow.stage === "current") {
          setEmailChangeFlow({ ...emailChangeFlow, stage: "new" });
          setVerificationCode(emptyVerificationCode());
          setVerificationNotice("Código confirmado. Ahora ingresa el código enviado a tu nueva dirección.");
          return;
        }

        let refreshedAuth = await refreshAuth();
        if (
          refreshedAuth.user?.email?.toLowerCase() !== emailChangeFlow.newEmail.toLowerCase()
          && data.user?.email?.toLowerCase() === emailChangeFlow.newEmail.toLowerCase()
        ) {
          const { data: currentUser, error: currentUserError } = await supabase.auth.getUser();
          if (!currentUserError && currentUser.user.email?.toLowerCase() === emailChangeFlow.newEmail.toLowerCase()) {
            refreshedAuth = await refreshAuth();
          }
        }
        const confirmedEmail = refreshedAuth.user?.email?.toLowerCase();
        if (confirmedEmail !== emailChangeFlow.newEmail.toLowerCase()) {
          setVerificationError("No pudimos comprobar que el nuevo correo quedó activo. Inténtalo nuevamente.");
          return;
        }

        setEmailChangeFlow(null);
        setVerificationOpen(false);
        setVerificationCode(emptyVerificationCode());
        emailStateRevision.current += 1;
        const currentUserId = user?.id;
        setPendingEmailState(currentUserId ? { userId: currentUserId, email: "" } : null);
        setServerPendingEmailState(currentUserId ? { userId: currentUserId, email: "" } : null);
        setProfileNotice("Información actualizada. Tus datos se guardaron correctamente. A partir de ahora podrás utilizar tu nuevo correo electrónico.");
      } catch (error) {
        console.error("No se pudo confirmar el cambio de correo.", error);
        setVerificationError("No se pudo comprobar el código. Revisa tu conexión e inténtalo nuevamente.");
      } finally {
        verifyInProgress.current = false;
        setIsVerifying(false);
      }
      return;
    }

    if (
      verifyInProgress.current
      || isVerificationExpired
      || !pendingOperation
      || !verificationChallenge
      || verificationCode.join("").length !== 6
    ) return;

    verifyInProgress.current = true;
    setIsVerifying(true);
    setVerificationError("");
    setVerificationLimitCode(null);
    setVerificationNotice("");
    try {
      const result = await verifyAndApplyProfileSettings(
        verificationChallenge.challengeId,
        verificationCode.join(""),
        pendingOperation,
      );
      if (!result.ok) {
        setVerificationError(getVerificationError(result.code));
        if (result.code === "expired") setVerificationRemainingSeconds(0);
        return;
      }

      setVerificationChallenge(null);
      setVerificationCode(emptyVerificationCode());
      setVerificationExpiresAt(0);
      setResendAvailableAt(0);
      setVerificationRemainingSeconds(0);
      setResendRemainingSeconds(0);
      const operation = pendingOperation;
      setPendingOperation(null);

      if (operation.newEmail) {
        try {
          const currentUser = user;
          const currentEmail = currentUser?.email?.trim();
          if (!currentUser || !currentEmail) {
            throw new Error("No se encontró el correo actual de la cuenta.");
          }
          emailStateRevision.current += 1;
          const { data, error } = await supabase.auth.updateUser({ email: operation.newEmail });
          if (error) {
            const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser();
            if (currentUserError) {
              emailStateRevision.current += 1;
              setPendingEmailState(null);
              setServerPendingEmailState(null);
              setPendingEmailCheck({ userId: currentUser.id, newEmail: operation.newEmail });
              setEmailChangeFlow(null);
              setVerificationOpen(false);
              setProfileNotice("");
              setEditing(false);
              return;
            }
            if (currentUserData.user.new_email?.toLowerCase() !== operation.newEmail.toLowerCase()) {
              throw error;
            }
            setPendingEmailState({ userId: currentUserData.user.id, email: operation.newEmail });
            setServerPendingEmailState({ userId: currentUserData.user.id, email: operation.newEmail });
            setEmailChangeFlow({
              currentEmail,
              newEmail: operation.newEmail,
              stage: "current",
            });
            setProfileNotice("");
            setVerificationNotice("Para completar el cambio, confirma primero el código enviado a tu correo actual y después el de tu nueva dirección.");
            return;
          }

          setPendingEmailState({ userId: currentUser.id, email: operation.newEmail });
          setServerPendingEmailState({ userId: currentUser.id, email: operation.newEmail });
          setEmailChangeFlow({
            currentEmail,
            newEmail: operation.newEmail,
            stage: "current",
          });
          setProfileNotice("");
          setVerificationError("");
          setVerificationNotice("Para completar el cambio, confirma primero el código enviado a tu correo actual y después el de tu nueva dirección.");
          if (data.user.new_email && data.user.new_email.toLowerCase() !== operation.newEmail.toLowerCase()) {
            throw new Error("El correo pendiente no coincide con la solicitud.");
          }
          return;
        } catch (error) {
          console.error("No se pudo iniciar el cambio de correo.", error);
          setVerificationOpen(false);
          setEmailChangeFlow(null);
          const currentUserId = user?.id;
          setPendingEmailState(currentUserId ? { userId: currentUserId, email: "" } : null);
          setServerPendingEmailState(currentUserId ? { userId: currentUserId, email: "" } : null);
          setFieldErrors({ email: getEmailErrorFromUnknown(error) });
          setProfileNotice(operation.updateProfile
            ? "Tus datos personales se guardaron, pero el correo actual sigue activo."
            : "");
          setEditing(true);
          return;
        }
      }

      setVerificationOpen(false);
      setProfileNotice(operation.updateProfile
        ? "Información actualizada. Tus datos se guardaron correctamente."
        : "La identidad se verificó correctamente.");
    } catch (error) {
      console.error("La verificación del perfil no pudo completarse.", error);
      setVerificationError("No se pudo completar la verificación. Comprueba tu conexión y revisa el perfil antes de volver a intentarlo.");
    } finally {
      verifyInProgress.current = false;
      setIsVerifying(false);
    }
  }

  async function resendEmailChangeCodes() {
    if (!emailChangeFlow || resendInProgress.current || isVerifying || isResending) return;
    resendInProgress.current = true;
    setIsResending(true);
    setVerificationError("");
    setVerificationNotice("");
    try {
      const { error } = await supabase.auth.resend({
        type: "email_change",
        email: emailChangeFlow.currentEmail,
      });
      if (error) {
        setVerificationError(getEmailError(error));
        return;
      }
      setEmailChangeFlow({ ...emailChangeFlow, stage: "current" });
      setVerificationCode(emptyVerificationCode());
      setVerificationNotice("Enviamos códigos nuevos a tu correo actual y a tu nueva dirección. Los anteriores ya no son válidos.");
    } catch (error) {
      console.error("No se pudieron reenviar los códigos del cambio de correo.", error);
      setVerificationError("No se pudieron enviar nuevos códigos. Comprueba tu conexión e inténtalo nuevamente.");
    } finally {
      resendInProgress.current = false;
      setIsResending(false);
    }
  }

  function continuePendingEmailChange() {
    const newEmail = serverPendingEmail || authPendingEmail || pendingEmail;
    if (!newEmail || !user?.email || isResending) return;
    setEmailChangeFlow({ currentEmail: user.email, newEmail, stage: "current" });
    setVerificationCode(emptyVerificationCode());
    setVerificationError("");
    setVerificationNotice("");
    setVerificationOpen(true);
  }

  async function checkPendingEmailStatus() {
    if (!user?.id || !isOnline || isCheckingPendingEmail) return;
    setIsCheckingPendingEmail(true);
    setProfileNotice("");
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user || data.user.id !== user.id) {
        setProfileNotice("No pudimos comprobar el estado. Revisa tu conexión e inténtalo nuevamente.");
        return;
      }

      const currentPendingEmail = data.user.new_email?.trim() ?? "";
      setServerPendingEmailState({ userId: user.id, email: currentPendingEmail });
      setPendingEmailState({ userId: user.id, email: currentPendingEmail });
      setPendingEmailCheck(null);
      if (currentPendingEmail) {
        setEmailChangeFlow({
          currentEmail: data.user.email ?? user.email ?? "",
          newEmail: currentPendingEmail,
          stage: "current",
        });
      } else {
        setEmailChangeFlow(null);
        setProfileNotice("No hay un cambio de correo pendiente. Puedes volver a solicitarlo.");
        setEditing(true);
      }
    } catch (error) {
      console.error("No se pudo comprobar el estado del cambio de correo.", error);
      setProfileNotice("No pudimos comprobar el estado. Revisa tu conexión e inténtalo nuevamente.");
    } finally {
      setIsCheckingPendingEmail(false);
    }
  }

  async function requestAnotherCode() {
    if (emailChangeFlow) {
      await resendEmailChangeCodes();
      return;
    }
    if (
      resendInProgress.current
      || isVerifying
      || isResending
      || resendRemainingSeconds > 0
      || !pendingOperation
    ) return;
    resendInProgress.current = true;
    setIsResending(true);
    setVerificationError("");
    setVerificationLimitCode(null);
    setVerificationNotice("");
    try {
      const request = await requestProfileSettingsVerification(pendingOperation);
      if (!request.ok) {
        const nextResendAt = getRetryAtTimestamp(request.retryAt, request.retryAfterSeconds);
        const retrySeconds = nextResendAt > 0
          ? Math.max(0, Math.ceil((nextResendAt - Date.now()) / 1000))
          : request.retryAfterSeconds ?? 0;
        if (
          (request.code === "rate_limited" || request.code === "resend_cooldown")
          && nextResendAt > Date.now()
        ) {
          setVerificationLimitCode(request.code);
          setResendAvailableAt(nextResendAt);
          setResendRemainingSeconds(retrySeconds);
          setVerificationError("");
        } else {
          setVerificationError(getVerificationError(request.code, retrySeconds));
        }
        return;
      }
      applyVerificationChallenge(request.challenge);
      setVerificationCode(emptyVerificationCode());
      setVerificationError("");
      setVerificationLimitCode(null);
      setVerificationNotice("Enviamos un código nuevo. El anterior dejó de ser válido.");
    } catch (error) {
      console.error("No se pudo reenviar el código de identidad.", error);
      setVerificationError("No se pudo solicitar otro código. Comprueba tu conexión e inténtalo nuevamente.");
    } finally {
      resendInProgress.current = false;
      setIsResending(false);
    }
  }

  function handleVerificationCodeChange(index: number, value: string) {
    const digits = value.replace(/\D/g, "");
    const nextCode = [...verificationCode];
    if (!digits) {
      nextCode[index] = "";
      setVerificationCode(nextCode);
      setVerificationError("");
      setVerificationLimitCode(null);
      setVerificationNotice("");
      return;
    }

    [...digits].forEach((digit, offset) => {
      if (index + offset < nextCode.length) nextCode[index + offset] = digit;
    });
    setVerificationCode(nextCode);
    setVerificationError("");
    setVerificationLimitCode(null);
    setVerificationNotice("");
    const nextInputIndex = index + digits.length;
    if (nextInputIndex < nextCode.length) verificationCodeInputs.current[nextInputIndex]?.focus();
  }

  function handleVerificationPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const nextCode = emptyVerificationCode();
    [...digits].forEach((digit, index) => {
      nextCode[index] = digit;
    });
    setVerificationCode(nextCode);
    setVerificationError("");
    setVerificationLimitCode(null);
    setVerificationNotice("");
    verificationCodeInputs.current[Math.min(digits.length, 5)]?.focus();
  }

  function handleVerificationKeyDown(index: number, event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !verificationCode[index] && index > 0) {
      verificationCodeInputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowLeft" && index > 0) {
      verificationCodeInputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < 5) {
      verificationCodeInputs.current[index + 1]?.focus();
    }
  }

  async function handleSignOut() {
    if (isSigningOut) return;
    setSignOutError("");
    setIsSigningOut(true);
    try {
      const error = await signOut();
      if (error) {
        setSignOutError(error);
        return;
      }
      navigate("/", { replace: true });
    } catch (error) {
      console.error("No se pudo cerrar la sesión.", error);
      setSignOutError("No se pudo cerrar la sesión. Inténtalo nuevamente.");
    } finally {
      setIsSigningOut(false);
    }
  }

  const displayedEmail = user?.email || "Correo no disponible";
  const authPendingEmail = user && "new_email" in user ? user.new_email : undefined;
  const displayedName = profile?.full_name || "Perfil no disponible";
  const displayedPhone = profile?.phone || "Teléfono no registrado";
  const displayedRole = profile?.role === "administrador" ? "Administrador" : profile?.role === "empleado" ? "Empleado" : "No disponible";
  const emailAwaitingConfirmation = serverPendingEmail !== null
    ? serverPendingEmail
    : pendingEmailCheck?.userId === user?.id
      ? ""
      : authPendingEmail || pendingEmail;
  const emailConfirmed = Boolean(emailAwaitingConfirmation && user?.email?.toLowerCase() === emailAwaitingConfirmation.toLowerCase());
  const displayedProfileNotice = emailConfirmed
    ? "Información actualizada. Tus datos se guardaron correctamente. A partir de ahora podrás utilizar tu nuevo correo electrónico."
    : profileNotice;

  return (
    <div className="dashboard settings-page">
      <Sidebar />

      <main className="content settings-content">
        <header className="content-header settings-header">
          <span className="settings-eyebrow">Preferencias de cuenta</span>
          <h1>Configuración</h1>
          <p>Consulta y actualiza la información de tu cuenta.</p>
        </header>

        <section className="settings-panel">
          <div className="profile-summary">
            <div className="profile-icon" aria-hidden="true"><UserRound size={42} strokeWidth={1.8} /></div>
            <div className="profile-info">
              <span className="settings-eyebrow">Mi perfil</span>
              <h2>{displayedName}</h2>
              <p>{displayedEmail}</p>
              <p>{displayedPhone}</p>
              <span className="profile-role">{displayedRole}</span>
              <button
                type="button"
                className="edit-profile-button"
                onClick={openEditor}
                disabled={!changesAvailable}
              >
                Editar información
              </button>
            </div>
          </div>

          <div className="profile-divider" />
          <p className="profile-note">Mantén tus datos actualizados para identificarte correctamente dentro de la biblioteca.</p>

          {(!isOnline || status === "offline") && (
            <p className="settings-offline-note" role="status">
              No hay conexión disponible. Los cambios del perfil requieren conexión a Internet.
            </p>
          )}
          {!profileAvailable && status !== "offline" && (
            <p className="settings-offline-note" role="status">
              El perfil real no está disponible en este momento; no se mostrarán datos locales de prueba.
            </p>
          )}
          {displayedProfileNotice && <p className="settings-success" role="status">{displayedProfileNotice}</p>}
          {pendingEmailCheck?.userId === user?.id && (
            <div className="settings-offline-note" role="status">
              <p>No pudimos comprobar el estado del cambio. Vuelve a intentarlo antes de iniciar otra solicitud.</p>
              <button
                type="button"
                className="settings-pending-email-action"
                onClick={() => { void checkPendingEmailStatus(); }}
                disabled={!isOnline || isCheckingPendingEmail}
              >
                {isCheckingPendingEmail ? "Comprobando..." : "Comprobar de nuevo"}
              </button>
            </div>
          )}
          {emailAwaitingConfirmation && !emailConfirmed && (
            <div className="settings-pending-email" role="status">
              <strong className="settings-pending-email-title">Cambio de correo pendiente.</strong>
              <p>Aún falta confirmar tu nuevo correo electrónico. Puedes continuar con la verificación; tu correo actual y los demás datos del perfil se conservan mientras tanto.</p>
              <button
                type="button"
                className="settings-pending-email-action"
                onClick={() => {
                  if (emailChangeFlow) setVerificationOpen(true);
                  else continuePendingEmailChange();
                }}
                disabled={isResending}
              >
                Continuar verificación
              </button>
            </div>
          )}

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

          <section className="settings-session" aria-labelledby="settings-session-title">
            <div>
              <span className="settings-eyebrow">Cuenta</span>
              <h2 id="settings-session-title">Sesión</h2>
              <p>Cierra de forma segura la sesión de tu cuenta.</p>
            </div>
            <button type="button" className="settings-sign-out" onClick={() => { void handleSignOut(); }} disabled={isSigningOut}>
              <LogOut size={17} aria-hidden="true" />
              {isSigningOut ? "Cerrando sesión..." : "Cerrar sesión"}
            </button>
            {signOutError && <p className="settings-error" role="alert">{signOutError}</p>}
          </section>
        </section>
      </main>

      {editing && (
        <div className="settings-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isSaving) setEditing(false);
        }}>
          <section className="settings-edit-modal" role="dialog" aria-modal="true" aria-labelledby="settings-edit-title">
            <header className="settings-modal-header">
              <div>
                <span className="settings-eyebrow">Mi perfil</span>
                <h2 id="settings-edit-title">Editar información</h2>
              </div>
              <button type="button" className="settings-modal-close" onClick={() => setEditing(false)} disabled={isSaving} aria-label="Cerrar edición">
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <p className="settings-modal-intro">Actualiza los datos de tu cuenta. El rol y los permisos no se pueden modificar desde aquí.</p>

            <form className="settings-form" onSubmit={(event) => { void handleSubmit(event); }} noValidate>
              <label htmlFor="settings-name">Nombre completo <span aria-hidden="true">*</span></label>
              <input
                id="settings-name"
                type="text"
                autoComplete="name"
                maxLength={100}
                value={draftName}
                onChange={(event) => { setDraftName(event.target.value); setFieldErrors((current) => ({ ...current, name: undefined })); }}
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? "settings-name-error" : undefined}
                required
              />
              {fieldErrors.name && <span id="settings-name-error" className="settings-field-error">{fieldErrors.name}</span>}

              <label htmlFor="settings-email">Correo electrónico <span aria-hidden="true">*</span></label>
              <input
                id="settings-email"
                type="email"
                autoComplete="email"
                maxLength={254}
                value={draftEmail}
                onChange={(event) => { setDraftEmail(event.target.value); setFieldErrors((current) => ({ ...current, email: undefined })); }}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "settings-email-error" : undefined}
                required
              />
              {fieldErrors.email && <span id="settings-email-error" className="settings-field-error">{fieldErrors.email}</span>}

              <label htmlFor="settings-phone">Número de teléfono <span className="settings-optional">(opcional)</span></label>
              <input
                id="settings-phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                maxLength={20}
                placeholder="10 dígitos o +52"
                value={draftPhone}
                onChange={(event) => { setDraftPhone(event.target.value); setFieldErrors((current) => ({ ...current, phone: undefined })); }}
                aria-invalid={Boolean(fieldErrors.phone)}
                aria-describedby={fieldErrors.phone ? "settings-phone-error" : undefined}
              />
              {fieldErrors.phone && <span id="settings-phone-error" className="settings-field-error">{fieldErrors.phone}</span>}

              {formError && <p className="settings-error" role="alert">{formError}</p>}

              <div className="settings-form-actions">
                <button type="button" className="cancel-settings-button form-visual-cancel" onClick={() => setEditing(false)} disabled={isSaving}>Cancelar</button>
                <button type="submit" className="form-visual-save" disabled={isSaving || requestRetryRemainingSeconds > 0}>
                  {isSaving ? "Enviando código..." : "Guardar cambios"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {verificationOpen && (verificationChallenge || emailChangeFlow) && (
        <div className="settings-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isVerifying && !isResending) {
            void handleCancelVerification();
          }
        }}>
          <section className="settings-edit-modal settings-verification-modal" role="dialog" aria-modal="true" aria-labelledby="settings-verification-title">
            <header className="settings-modal-header">
              <div className="settings-verification-icon" aria-hidden="true"><MailCheck size={26} strokeWidth={1.8} /></div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => { void handleCancelVerification(); }}
                disabled={isVerifying || isResending}
                aria-label={emailChangeFlow ? "Salir por ahora" : "Cancelar"}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            {hasThreeStepEmailChange && (
              <p className="settings-verification-progress">Paso {emailChangeStep} de 3</p>
            )}
            <span className="settings-eyebrow">Seguridad de la cuenta</span>
            <h2 id="settings-verification-title">
              {emailChangeFlow
                ? emailChangeFlow.stage === "current" ? "Confirma tu correo actual" : "Confirma tu nuevo correo"
                : "Verifica tu identidad"}
            </h2>
            <p className="settings-modal-intro">
              {emailChangeFlow
                ? emailChangeFlow.stage === "current"
                  ? "Enviamos un código a tu correo actual para autorizar el cambio. Ingrésalo para continuar."
                  : "Ya confirmaste tu correo actual. Ahora ingresa el código enviado a tu nueva dirección para completar el cambio."
                : "Por tu seguridad, enviamos un código a tu correo registrado. Ingrésalo para confirmar que eres tú."}
            </p>
            <strong className="settings-verification-email">
              {emailChangeFlow ? maskEmail(emailChangeTarget) : verificationChallenge?.maskedEmail}
            </strong>
            {emailChangeFlow?.stage === "current" && (
              <p className="settings-verification-email-note">
                También enviamos un código a tu nuevo correo. Puedes recibir ambos al mismo tiempo.
              </p>
            )}

            <form className="settings-form" onSubmit={(event) => { void handleVerifyAndSave(event); }} noValidate>
              <label htmlFor="settings-verification-code">Código de verificación</label>
              <div className="settings-verification-code-inputs" role="group" aria-label="Código de 6 dígitos">
                {verificationCode.map((digit, index) => (
                  <input
                    key={index}
                    id={index === 0 ? "settings-verification-code" : undefined}
                    ref={(element) => { verificationCodeInputs.current[index] = element; }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    pattern="[0-9]"
                    maxLength={1}
                    placeholder=""
                    value={digit}
                    onChange={(event) => handleVerificationCodeChange(index, event.target.value)}
                    onKeyDown={(event) => handleVerificationKeyDown(index, event)}
                    onPaste={handleVerificationPaste}
                    disabled={isVerifying || isResending || isVerificationExpired}
                    aria-label={`Dígito ${index + 1} de 6`}
                    aria-invalid={Boolean(verificationErrorMessage)}
                    aria-describedby={verificationErrorMessage
                      ? "settings-verification-error"
                      : "settings-verification-help"}
                    required
                  />
                ))}
              </div>
              <p id="settings-verification-help" className="settings-verification-help">
                {emailChangeFlow
                  ? "Si el código ya venció, solicita uno nuevo."
                  : <>Código válido por 5 minutos. Tiempo restante: <strong>{formatCountdown(verificationRemainingSeconds)}</strong></>}
              </p>
              {isVerificationExpired && (
                <p className="settings-verification-error" role="alert">
                  El código venció. Solicita otro para continuar.
                </p>
              )}
              {verificationNotice && (
                <p className="settings-verification-success" role="status">{verificationNotice}</p>
              )}
              {verificationErrorMessage && !isVerificationExpired && (
                <p id="settings-verification-error" className="settings-verification-error" role="alert">
                  {verificationErrorMessage}
                </p>
              )}

              <div className="settings-verification-actions">
                <button
                  type="submit"
                  disabled={isVerifying || isResending || isVerificationExpired || verificationCode.join("").length !== 6}
                >
                  {isVerifying
                    ? <><LoaderCircle size={16} className="settings-spinner" aria-hidden="true" /> Verificando...</>
                    : emailChangeFlow
                      ? emailChangeFlow.stage === "new" ? "Confirmar cambio" : "Continuar"
                      : "Verificar identidad"}
                </button>
                <button
                  type="button"
                  className="settings-verification-cancel"
                  onClick={() => { void handleCancelVerification(); }}
                  disabled={isVerifying || isResending}
                >
                  {emailChangeFlow ? "Salir por ahora" : "Cancelar"}
                </button>
              </div>
              <button
                type="button"
                className="settings-verification-resend"
                onClick={() => { void requestAnotherCode(); }}
                disabled={isVerifying || isResending || resendRemainingSeconds > 0}
              >
                {isResending
                  ? <><LoaderCircle size={16} className="settings-spinner" aria-hidden="true" /> Enviando...</>
                  : resendRemainingSeconds > 0
                    ? `Reenviar código (${formatCountdown(resendRemainingSeconds)})`
                    : emailChangeFlow ? "Reenviar códigos" : "Reenviar código"}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default Configuracion;
