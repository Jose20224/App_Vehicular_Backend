import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="auth-screen">
          <h1>No pudimos abrir esta pantalla</h1>
          <p>Vuelve a iniciar la aplicación para recuperar la sesión.</p>
          <button className="button" onClick={() => window.location.reload()}>
            Volver a abrir
          </button>
        </main>
      );
    return this.props.children;
  }
}
