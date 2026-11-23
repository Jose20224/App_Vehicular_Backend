import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, Link } from 'react-router-dom';
import { useSession } from './session';
import { Icon, Loading, useOnline } from './ui';
import { Welcome, Login } from './pages/Auth';
import { Dashboard, VehicleDetail, VehicleForm } from './pages/Vehicles';
import { DocumentDetail, DocumentForm, PolicyForm, PolicyDetail } from './pages/Documents';
import { Capacitor } from '@capacitor/core';
import { API_BASE } from './api';
const Directory = lazy(() => import('./pages/Directory'));
const AssistancePages = lazy(() => import('./pages/Assistance'));
const SettingsPages = lazy(() => import('./pages/Settings'));
function Protected() {
  return useSession().user ? <Outlet /> : <Navigate to="/bienvenida" replace />;
}
function Layout() {
  const { user } = useSession();
  const online = useOnline();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/inicio" className="brand">
          <span className="brand-mark">
            <Icon name="shield" size={25} />
          </span>
          <span>
            <small>
              {user ? `¡Hola, ${user.display_name.split(' ')[0]}!` : 'Tu vehículo, en buenas manos'}
            </small>
            <strong>
              Registro <b>S.A.</b>
            </strong>
          </span>
        </Link>
        <Link className="icon-button" aria-label="Notificaciones" to="/notificaciones">
          <Icon name="bell" />
        </Link>
      </header>
      {!online && (
        <div role="status" className="offline-banner">
          <Icon name="offline" size={18} />
          <span>Sin conexión · Solo datos de esta sesión. Las acciones requieren internet.</span>
        </div>
      )}
      <main id="main" className="content">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="bottomnav" aria-label="Navegación principal">
        {[
          ['/inicio', 'home', 'Inicio'],
          ['/talleres', 'workshop', 'Talleres'],
          ['/asistencia', 'help', 'Auxilio'],
          ['/ajustes', 'settings', 'Mi cuenta'],
        ].map(([to, icon, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={icon as 'home'} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
export function App() {
  if (Capacitor.isNativePlatform() && !/^https:\/\//.test(API_BASE)) {
    return (
      <main className="auth-screen">
        <h1>Configura la conexión de la app</h1>
        <p>
          Esta compilación necesita la dirección HTTPS de la API. Configura VITE_API_URL y vuelve a
          sincronizar el proyecto nativo.
        </p>
      </main>
    );
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <Routes>
        <Route path="/bienvenida" element={<Welcome />} />
        <Route path="/ingresar" element={<Login />} />
        <Route element={<Protected />}>
          <Route element={<Layout />}>
            <Route path="/inicio" element={<Dashboard />} />
            <Route path="/vehiculos/nuevo" element={<VehicleForm />} />
            <Route path="/vehiculos/:id" element={<VehicleDetail />} />
            <Route path="/vehiculos/:id/editar" element={<VehicleForm />} />
            <Route path="/vehiculos/:id/documentos/nuevo" element={<DocumentForm />} />
            <Route path="/documentos/:id" element={<DocumentDetail />} />
            <Route path="/vehiculos/:id/polizas/nueva" element={<PolicyForm />} />
            <Route path="/vehiculos/:id/polizas/:policyId" element={<PolicyDetail />} />
            <Route path="/talleres/*" element={<Directory />} />
            <Route path="/asistencia/*" element={<AssistancePages />} />
            <Route path="/ajustes/*" element={<SettingsPages />} />
            <Route path="/notificaciones" element={<SettingsPages view="notifications" />} />
            <Route path="/contactos" element={<SettingsPages view="contacts" />} />
            <Route path="/recordatorios" element={<SettingsPages view="reminders" />} />
            <Route path="*" element={<Navigate to="/inicio" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/bienvenida" replace />} />
      </Routes>
    </>
  );
}
