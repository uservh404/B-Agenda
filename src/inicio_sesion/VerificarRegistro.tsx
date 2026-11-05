import { useRef, useState } from "react";
import type { FormEvent, ClipboardEvent, KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import "./S-login.css";

function VerificarRegistro() {
  const location = useLocation();
  const navigate = useNavigate();
  const correo = (location.state as { correo?: string } | null)?.correo;
  const [codigo, setCodigo] = useState<string[]>(Array(6).fill(""));
  const codeInputs = useRef<(HTMLInputElement | null)[]>([]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate("/");
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
                maxLength={6}
                value={digit}
                onChange={(event) => handleCodeChange(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={handlePaste}
                aria-label={`Dígito ${index + 1} de 6`}
                required
              />
            ))}
          </div>
          <button type="submit">Confirmar registro</button>
        </form>

        <Link to="/registro">Volver al registro</Link>
      </div>
    </div>
  );
}

export default VerificarRegistro;
