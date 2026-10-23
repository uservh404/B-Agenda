import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./S-login.css";

function VerificarCodigo() {
  const navigate = useNavigate();
  const [codigo, setCodigo] = useState<string[]>(Array(6).fill(""));
  const codeInputs = useRef<(HTMLInputElement | null)[]>([]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate("/nueva-password");
  }

  function handleCodeChange(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(-1);
    const nextCode = [...codigo];
    nextCode[index] = digit;
    setCodigo(nextCode);

    if (digit && index < 5) {
      codeInputs.current[index + 1]?.focus();
    }
  }

  return (
    <div className="contenedor">
      <div className="login">
        <h1>Biblioteca digital</h1>
        <p>Verificar código</p>
        <p className="texto-ayuda">Revisa tu correo e introduce el código de 6 dígitos que te enviamos.</p>

        <form onSubmit={handleSubmit}>
          <label>Código de verificación</label>
          <div className="code-inputs" aria-label="Código de 6 dígitos">
            {codigo.map((digit, index) => (
              <input
                key={index}
                ref={(element) => { codeInputs.current[index] = element; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(event) => handleCodeChange(index, event.target.value)}
                aria-label={`Dígito ${index + 1} de 6`}
                required
              />
            ))}
          </div>
          <button type="submit">Verificar código</button>
        </form>

        <Link to="/recuperar-password">Volver</Link>
      </div>
    </div>
  );
}

export default VerificarCodigo;