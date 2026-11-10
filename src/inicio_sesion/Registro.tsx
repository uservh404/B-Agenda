import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import "./S-registro.css";

function Registro() {
    const navigate = useNavigate();
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

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

        if (!nombre || !apellidos || !telefono || !correo || !contrasena || !confirmarContrasena) {
            setError("Completa todos los campos obligatorios.");
            return;
        }

        if (contrasena.length < 8) {
            setError("La contraseña debe tener al menos 8 caracteres.");
            return;
        }

        if (contrasena !== confirmarContrasena) {
            setError("Las contraseñas no coinciden.");
            return;
        }

        setError("");
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
            setError(signUpError.message || "No se pudo completar el registro.");
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
                <form onSubmit={handleSubmit}>
                    <input type="text" name="nombre" placeholder="Ingrese su nombre" required/>

            
                    <input type="text" name="apellidos" placeholder="Ingrese sus apellidos" required/>

                
                    <input type="tel" name="telefono" placeholder="Ingrese su número telefónico" required/>

                
                    <input type="email" name="correo" placeholder="Ingrese su correo electronico" required/>

                    <input type="password" name="contrasena" placeholder="Ingrese su contraseña" minLength={8} required/>

                
                    <input type="password" name="confirmarContrasena" placeholder="Confirme su contraseña" minLength={8} required/>

                    {error && <p className="registro-mensaje registro-error" role="alert">{error}</p>}

                    <button type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Registrando..." : "Registrar"}
                    </button>
                </form>


            </div>
        </div>

    )
}
export default Registro;
