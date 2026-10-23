import { Routes, Route, useNavigate } from "react-router-dom";
// Routes = conjunto de rutas.
// Route = una ruta individual.
//
// Permiten crear las diferentes pantallas de la aplicación.

import Login from "./inicio_sesion/Login";
// Importa el componente Login para utilizarlo
// como una de las pantallas de la aplicación.

import Registro from "./inicio_sesion/Registro";
// Importa el componente Registro para utilizarlo
// como una de las pantallas de la aplicación.

import RecuperarPassword from "./inicio_sesion/RecuperarPassword";
import VerificarCodigo from "./inicio_sesion/VerificarCodigo";
import NuevaPassword from "./inicio_sesion/NuevaPassword";

import Principal from "./tabs/Principal";
// Importa la pantalla principal de administración.

import Anuncios from "./tabs/Anuncios";
// Importa la pantalla de anuncios.

import Recursos from "./tabs/Recursos";
// Importa la pantalla de recursos.

import Usuarios from "./tabs/Usuarios";
import Configuracion from "./tabs/Configuracion";
import Notificaciones from "./tabs/Notificaciones";
import { isAdministrator } from "./auth/permissions";
import "./auth/S-permissions.css";

function PermissionDenied() {
  const navigate = useNavigate();

  return (
    <main className="permission-page">
      <section className="permission-modal" role="alert" aria-labelledby="permission-title">
        <div className="permission-icon" aria-hidden="true">🔒</div>
        <div>
          <h1 id="permission-title">Permisos insuficientes</h1>
          <p>No tienes los permisos suficientes para acceder a esta opción.</p>
        </div>
        <button type="button" onClick={() => navigate("/principal")}>Volver al inicio</button>
      </section>
    </main>
  );
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  return isAdministrator() ? children : <PermissionDenied />;
}

function App() {
  return (
    <Routes>
      {/* Route = ruta.
          path = camino o dirección.
          "/" representa la pantalla principal.
          element indica qué componente se mostrará. */}
      <Route path="/" element={<Login />} />

      {/* Cuando la ruta sea "/registro",
          React mostrará el componente Registro. */}
      <Route path="/registro" element={<Registro />} />

      <Route path="/recuperar-password" element={<RecuperarPassword />} />
      <Route path="/verificar-codigo" element={<VerificarCodigo />} />
      <Route path="/nueva-password" element={<NuevaPassword />} />

      {/* Cuando la ruta sea "/principal",
          React mostrará la pantalla principal de administración. */}
      <Route path="/principal" element={<Principal />} />

      {/* Cuando la ruta sea "/anuncios",
          React mostrará la pantalla de anuncios. */}
      <Route path="/anuncios" element={<Anuncios />} />

      <Route path="/notificaciones" element={<Notificaciones />} />

      {/* Cuando la ruta sea "/recursos",
          React mostrará la pantalla de recursos. */}
      <Route path="/recursos" element={<Recursos />} />

      <Route path="/usuarios" element={<AdminRoute><Usuarios /></AdminRoute>} />
      <Route path="/configuracion" element={<Configuracion />} />
    </Routes>
  );
}

export default App;