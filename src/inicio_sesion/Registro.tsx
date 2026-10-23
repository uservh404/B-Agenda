import "./S-registro.css";

function Registro() {
    return(
        <div className="contenedorf">

            <div className="registro">
                
                <h1>Registra tu usuario</h1>
                <input type="text" placeholder="Ingrese su nombre"/>

            
                <input type="text" placeholder="Ingrese sus apellidos"/>

                
                <input type="tel" placeholder="Ingrese su número telefónico"/>

                
                <input type="email" placeholder="Ingrese su correo electronico"/>

                <select name="tipoUsuario" defaultValue="" >
                    <option value="" disabled>Seleccione tipo de usuario</option>
                    <option value="administrador">Administrador</option>
                    <option value="empleado">Empleado</option>
                </select>
                
                <input type="password" placeholder="Ingrese su contraseña"/>

                
                <input type="password" placeholder="Confirme su contraseña"/>

                <button>Registrar</button>


            </div>
        </div>

    )
}
export default Registro;
