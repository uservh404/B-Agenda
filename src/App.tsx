import { Routes, Route, Navigate, useLocation } from "react-router-dom";
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

import VerificarRegistro from "./inicio_sesion/VerificarRegistro";
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
import { useAuth } from "./auth/useAuth";
import "./auth/S-permissions.css";

function AuthStatusScreen({ title, message, action }: { title: string; message: string; action: React.ReactNode }) {
  return (
    <main className="permission-page">
      <section className="permission-modal" role="status">
        <div className="permission-icon" aria-hidden="true">🔒</div>
        <div>
          <h1>{title}</h1>
          <p>{message}</p>
        </div>
        {action}
      </section>
    </main>
  );
}

function AuthenticatedRoute({ children, administratorOnly = false }: { children: React.ReactNode; administratorOnly?: boolean }) {
  const { status, profile, error, signOut } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <AuthStatusScreen
        title="Comprobando acceso"
        message="Estamos verificando tu sesión y perfil."
        action={<span aria-live="polite">Cargando...</span>}
      />
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  if (status === "recovery") {
    return <Navigate to="/nueva-password" replace />;
  }

  if (status === "error") {
    return (
      <AuthStatusScreen
        title="No se pudo validar el acceso"
        message={error ?? "No se pudo consultar tu perfil. El acceso permanece bloqueado."}
        action={<button type="button" onClick={() => { void signOut(); }}>Regresar al inicio de sesión</button>}
      />
    );
  }

  if (administratorOnly && profile?.role !== "administrador") {
    return <Navigate to="/principal" replace />;
  }

  return <>{children}</>;
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
      <Route path="/verificar-registro" element={<VerificarRegistro />} />

      <Route path="/recuperar-password" element={<RecuperarPassword />} />
      <Route path="/verificar-codigo" element={<VerificarCodigo />} />
      <Route path="/nueva-password" element={<NuevaPassword />} />

      {/* Cuando la ruta sea "/principal",
          React mostrará la pantalla principal de administración. */}
      <Route path="/principal" element={<AuthenticatedRoute><Principal /></AuthenticatedRoute>} />

      {/* Cuando la ruta sea "/anuncios",
          React mostrará la pantalla de anuncios. */}
      <Route path="/anuncios" element={<AuthenticatedRoute><Anuncios /></AuthenticatedRoute>} />

      <Route path="/notificaciones" element={<AuthenticatedRoute><Notificaciones /></AuthenticatedRoute>} />

      {/* Cuando la ruta sea "/recursos",
          React mostrará la pantalla de recursos. */}
      <Route path="/recursos" element={<AuthenticatedRoute><Recursos /></AuthenticatedRoute>} />

      <Route path="/usuarios" element={<AuthenticatedRoute administratorOnly><Usuarios /></AuthenticatedRoute>} />
      <Route path="/configuracion" element={<AuthenticatedRoute><Configuracion /></AuthenticatedRoute>} />
    </Routes>
  );
}

export default App;