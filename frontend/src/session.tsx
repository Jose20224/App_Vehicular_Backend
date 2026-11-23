import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getTokens, onSessionExpired, setTokens } from './api';
import type { Profile, Tokens } from './models';

interface Session {
  user: Profile | null;
  login: (tokens: Tokens, profile: Profile) => void;
  logout: () => Promise<void>;
  update: (profile: Profile) => void;
  purge: () => void;
}
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const queries = useQueryClient();
  function purge() {
    setTokens(null);
    setUser(null);
    void queries.cancelQueries();
    queries.clear();
  }
  useEffect(() => {
    onSessionExpired(purge);
    return () => onSessionExpired(() => {});
  }, [queries]);
  async function logout() {
    const current = getTokens();
    try {
      if (current)
        await api('/auth/logout', {
          method: 'POST',
          public: true,
          body: { refresh_token: current.refresh_token },
        });
    } finally {
      purge();
    }
  }
  return (
    <Context.Provider
      value={{
        user,
        login: (tokens, profile) => {
          queries.clear();
          setTokens(tokens);
          setUser(profile);
        },
        logout,
        update: setUser,
        purge,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error('SessionProvider requerido');
  return value;
}
