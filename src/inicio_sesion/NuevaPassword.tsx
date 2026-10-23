import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./S-login.css";

function NuevaPassword() {
  const navigate = useNavigate();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate("/");
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Nueva contraseña</p>
        <p className="texto-ayuda">Crea una contraseña nueva para volver a entrar a tu biblioteca digital.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="nueva-password">Nueva contraseña</label>
          <input id="nueva-password" type="password" placeholder="Ingrese su nueva contraseña" required />

          <label htmlFor="confirmar-password">Confirmar contraseña</label>
          <input id="confirmar-password" type="password" placeholder="Confirme su contraseña" required />

          <button type="submit">Guardar contraseña</button>
        </form>

        <Link to="/">Volver al inicio de sesión</Link>
      </div>
    </div>
  );
}

export default NuevaPassword;