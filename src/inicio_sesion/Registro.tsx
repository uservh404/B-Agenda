import { useState, type FormEvent } from "react";
import type { ChangeEvent, FocusEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AuthBackLink from "./AuthBackLink";
import "./S-registro.css";

type RegistrationField =
    | "nombre"
    | "apellidos"
    | "telefono"
    | "correo"
    | "contrasena"
    | "confirmarContrasena";

type RegistrationFieldErrors = Partial<Record<RegistrationField, string>>;

const registrationFields: RegistrationField[] = [
    "nombre",
    "apellidos",
    "telefono",
    "correo",
    "contrasena",
    "confirmarContrasena",
];

function isRegistrationField(value: string): value is RegistrationField {
    return registrationFields.includes(value as RegistrationField);
}

function getFieldError(field: RegistrationField, value: string, form: HTMLFormElement | null): string {
    switch (field) {
        case "nombre":
            return value.trim() ? "" : "Escribe tu nombre.";
        case "apellidos":
            return value.trim() ? "" : "Escribe tus apellidos.";
        case "telefono":
            return /^\d{10}$/.test(value)
                ? ""
                : "Escribe los 10 dígitos de tu número de teléfono.";
        case "correo":
            if (!value.trim()) return "Escribe tu correo electrónico.";
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
                ? "" : "Revisa que tu correo esté escrito correctamente.";
        case "contrasena":
            if (!value) return "Escribe una contraseña.";
            return value.length >= 8 ? "" : "Tu contraseña debe tener al menos 8 caracteres.";
        case "confirmarContrasena": {
            if (!value) return "Confirma tu contraseña.";
            const password = form?.elements.namedItem("contrasena");
            return password instanceof HTMLInputElement && value === password.value
                ? ""
                : "Las contraseñas no coinciden. Inténtalo nuevamente.";
        }
    }
}

function Registro() {
    const navigate = useNavigate();
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [fieldErrors, setFieldErrors] = useState<RegistrationFieldErrors>({});

    function updateFieldError(
        field: RegistrationField,
        input: HTMLInputElement,
        reveal: boolean,
    ) {
        const form = input.form;
        setFieldErrors((current) => {
            if (!reveal && !current[field]) return current;
            const next = { ...current };
            const message = getFieldError(field, input.value, form);
            if (message) next[field] = message;
            else delete next[field];

            if (field === "contrasena" && current.confirmarContrasena && form) {
                const confirmation = form.elements.namedItem("confirmarContrasena");
                if (confirmation instanceof HTMLInputElement) {
                    const confirmationError = getFieldError(
                        "confirmarContrasena",
                        confirmation.value,
                        form,
                    );
                    if (confirmationError) next.confirmarContrasena = confirmationError;
                    else delete next.confirmarContrasena;
                }
            }
            return next;
        });
    }

    function handleFieldBlur(event: FocusEvent<HTMLInputElement>) {
        const input = event.currentTarget;
        if (isRegistrationField(input.name)) updateFieldError(input.name, input, true);
    }

    function handleFieldChange(event: ChangeEvent<HTMLInputElement>) {
        const input = event.currentTarget;
        if (isRegistrationField(input.name)) updateFieldError(input.name, input, false);
    }

    function handleInvalid(event: FormEvent<HTMLFormElement>) {
        if (!(event.target instanceof HTMLInputElement) || !isRegistrationField(event.target.name)) return;
        event.preventDefault();
        updateFieldError(event.target.name, event.target, true);
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (isSubmitting) {
            return;
        }

        const formData = new FormData(event.currentTarget);
        const nombre = String(formData.get("nombre") ?? "").trim();
        const apellidos = String(formData.get("apellidos") ?? "").trim();
        const telefono = String(formData.get("telefono") ?? "").trim();
        const correo = String(formData.get("correo") ?? "").trim();
        const contrasena = String(formData.get("contrasena") ?? "");
        const confirmarContrasena = String(formData.get("confirmarContrasena") ?? "");

        const values: Record<RegistrationField, string> = {
            nombre,
            apellidos,
            telefono,
            correo,
            contrasena,
            confirmarContrasena,
        };
        const nextErrors: RegistrationFieldErrors = {};
        for (const field of registrationFields) {
            const message = getFieldError(field, values[field], event.currentTarget);
            if (message) nextErrors[field] = message;
        }
        setFieldErrors(nextErrors);
        setError("");
        if (Object.keys(nextErrors).length > 0) {
            return;
        }

        setIsSubmitting(true);

        const { data, error: signUpError } = await supabase.auth.signUp({
            email: correo,
            password: contrasena,
            options: {
                data: {
                    full_name: `${nombre} ${apellidos}`.trim(),
                    phone: telefono,
                },
            },
        });

        if (signUpError) {
            console.error("No se pudo completar el registro.", {
                code: signUpError.code,
                status: signUpError.status,
            });
            setError("No se pudo completar el registro. Revisa tus datos e inténtalo nuevamente.");
            setIsSubmitting(false);
            return;
        }

        if (!data.user) {
            setError("No se pudo crear la cuenta. Inténtalo nuevamente.");
            setIsSubmitting(false);
            return;
        }

        sessionStorage.setItem("biblioteca-signup-email", correo);
        sessionStorage.setItem("biblioteca-signup-code-expires-at", String(Date.now() + 5 * 60 * 1000));
        navigate("/verificar-registro", {
            state: { correo },
            replace: true,
        });
    }

    return(
        <div className="contenedorf">

            <div className="registro">
                
                <h1>Registra tu usuario</h1>
                <form onSubmit={handleSubmit} onInvalidCapture={handleInvalid}>
                    <div className="registro-field">
                        <input
                            type="text"
                            name="nombre"
                            placeholder="Ingrese su nombre"
                            required
                            aria-invalid={Boolean(fieldErrors.nombre)}
                            aria-describedby={fieldErrors.nombre ? "registro-error-nombre" : undefined}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.nombre && <p id="registro-error-nombre" className="registro-field-error" role="alert">{fieldErrors.nombre}</p>}
                    </div>

                    <div className="registro-field">
                        <input
                            type="text"
                            name="apellidos"
                            placeholder="Ingrese sus apellidos"
                            required
                            aria-invalid={Boolean(fieldErrors.apellidos)}
                            aria-describedby={fieldErrors.apellidos ? "registro-error-apellidos" : undefined}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.apellidos && <p id="registro-error-apellidos" className="registro-field-error" role="alert">{fieldErrors.apellidos}</p>}
                    </div>

                    <div className="registro-field registro-field-with-help">
                        <input
                            type="tel"
                            name="telefono"
                            placeholder="Ingrese su número telefónico"
                            inputMode="numeric"
                            pattern="[0-9]{10}"
                            required
                            aria-invalid={Boolean(fieldErrors.telefono)}
                            aria-describedby={fieldErrors.telefono ? "registro-error-telefono registro-ayuda-telefono" : "registro-ayuda-telefono"}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.telefono
                            && <p id="registro-error-telefono" className="registro-field-error" role="alert">{fieldErrors.telefono}</p>}
                        <p id="registro-ayuda-telefono" className="registro-ayuda">
                            <Info size={14} strokeWidth={1.8} aria-hidden="true" />
                            <span>Escribe los 10 dígitos de tu número de teléfono.</span>
                        </p>
                    </div>

                    <div className="registro-field">
                        <input
                            type="email"
                            name="correo"
                            placeholder="Ingrese su correo electrónico"
                            required
                            aria-invalid={Boolean(fieldErrors.correo)}
                            aria-describedby={fieldErrors.correo ? "registro-error-correo" : undefined}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.correo && <p id="registro-error-correo" className="registro-field-error" role="alert">{fieldErrors.correo}</p>}
                    </div>

                    <div className="registro-field registro-field-with-help">
                        <input
                            type="password"
                            name="contrasena"
                            placeholder="Ingrese su contraseña"
                            minLength={8}
                            required
                            aria-invalid={Boolean(fieldErrors.contrasena)}
                            aria-describedby={fieldErrors.contrasena ? "registro-error-contrasena registro-ayuda-contrasena" : "registro-ayuda-contrasena"}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.contrasena && <p id="registro-error-contrasena" className="registro-field-error" role="alert">{fieldErrors.contrasena}</p>}
                        <p id="registro-ayuda-contrasena" className="registro-ayuda">
                            <Info size={14} strokeWidth={1.8} aria-hidden="true" />
                            <span>Mínimo 8 caracteres. Puedes combinar letras, números y símbolos.</span>
                        </p>
                    </div>

                    <div className="registro-field">
                        <input
                            type="password"
                            name="confirmarContrasena"
                            placeholder="Confirme su contraseña"
                            minLength={8}
                            required
                            aria-invalid={Boolean(fieldErrors.confirmarContrasena)}
                            aria-describedby={fieldErrors.confirmarContrasena ? "registro-error-confirmar" : undefined}
                            onBlur={handleFieldBlur}
                            onChange={handleFieldChange}
                        />
                        {fieldErrors.confirmarContrasena && <p id="registro-error-confirmar" className="registro-field-error" role="alert">{fieldErrors.confirmarContrasena}</p>}
                    </div>

                    {error && <p className="registro-mensaje registro-error" role="alert">{error}</p>}

                    <button type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Registrando..." : "Registrar"}
                    </button>
                </form>

                <AuthBackLink to="/">Volver al inicio de sesión</AuthBackLink>
            </div>
        </div>

    )
}
export default Registro;
