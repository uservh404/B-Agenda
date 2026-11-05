import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import "./S-registro.css";

function Registro() {
    const navigate = useNavigate();

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const correo = formData.get("correo");
        navigate("/verificar-registro", {
            state: { correo: typeof correo === "string" ? correo : "" },
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

                    <select name="tipoUsuario" defaultValue="" required>
                        <option value="" disabled>Seleccione tipo de usuario</option>
                        <option value="administrador">Administrador</option>
                        <option value="empleado">Empleado</option>
                    </select>
                
                    <input type="password" name="contrasena" placeholder="Ingrese su contraseña" required/>

                
                    <input type="password" name="confirmarContrasena" placeholder="Confirme su contraseña" required/>

                    <button type="submit">Registrar</button>
                </form>


            </div>
        </div>

    )
}
export default Registro;
