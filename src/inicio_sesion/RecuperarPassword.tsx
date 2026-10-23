import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./S-login.css";

function RecuperarPassword() {
  const navigate = useNavigate();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate("/verificar-codigo");
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Recuperar contraseña</p>
        <p className="texto-ayuda">No te preocupes. Escribe tu correo y te enviaremos instrucciones para recuperar el acceso.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="correo">Correo electrónico</label>
          <input id="correo" type="email" placeholder="Ingrese su correo" required />
          <button type="submit">Continuar</button>
        </form>

        <Link to="/">Volver al inicio de sesión</Link>
      </div>
    </div>
  );
}

export default RecuperarPassword;