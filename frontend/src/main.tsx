import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './styles.css';
import { App } from './App';
import { SessionProvider } from './session';
import { ErrorBoundary } from './components/ErrorBoundary';
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <HashRouter>
        <SessionProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </SessionProvider>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
