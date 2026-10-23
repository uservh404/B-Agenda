import "./S-login.css"; /* importar archivo css para los estilos */
import { Link } from "react-router-dom";
/* Link = enlace.
Permite navegar entre pantallas sin recargar la aplicación. */

function Login() {
  /* crear una función llamada App para llamarla despues */
  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Inicio de sesión</p>

        <label>Usuario</label>
        <input type="text" placeholder="Ingrese su usuario" />

        <label>Contraseña</label>
        <input type="password" placeholder="Ingrese su contraseña" />

        <Link to="/principal">
          <button type="button">Iniciar sesión</button>
        </Link>
        <Link to="/recuperar-password">¿Olvidaste la contraseña?</Link>
        <p className="registro-prompt">¿Aún no tienes una cuenta?</p>
        <Link to="/registro">Registrar usuario</Link>
      </div>
    </div>
  );
}

export default Login; /* exporta la función Login para poder usarla en otros archivos */
