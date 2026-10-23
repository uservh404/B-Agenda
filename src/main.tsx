import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { BrowserRouter } from "react-router-dom";
import './themes.css'
import { applyAppTheme } from './theme'

applyAppTheme()

// import = importar.
// Browser = navegador.
// Router = enrutador.
//
// BrowserRouter permite que la aplicación pueda navegar entre diferentes
// pantallas utilizando React Router.

createRoot(document.getElementById('root')!).render(
<StrictMode>
    <BrowserRouter>
        <App />
    </BrowserRouter>
</StrictMode>
// Browser = navegador.
// Router = enrutador.
//
// BrowserRouter envuelve toda la aplicación para permitir
// la navegación entre diferentes pantallas utilizando React Router.
)