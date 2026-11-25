import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, api, onUnauthorized, setCsrfToken } from '../../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mockMode, setMockMode] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setCsrfToken(data.csrfToken);
      setUser(data.user);
      setMockMode(Boolean(data.mockMode));
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === 401) setUser(null);
    } finally {
      setStatus('ready');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/auth/me')
      .then((data) => {
        if (cancelled) return;
        setCsrfToken(data.csrfToken);
        setUser(data.user);
        setMockMode(Boolean(data.mockMode));
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setStatus('ready');
      });
    const unsubscribe = onUnauthorized(() => setUser(null));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Returns the user, or { mfaRequired: true } when the admin account has
  // 2FA on (then verifyMfa(code) completes the sign-in).
  const login = useCallback(async (identifier, password) => {
    const data = await api.post('/auth/login', { identifier, password });
    if (data.mfaRequired) return { mfaRequired: true };
    setCsrfToken(data.csrfToken);
    setUser(data.user);
    setMockMode(Boolean(data.mockMode));
    return data.user;
  }, []);

  const verifyMfa = useCallback(async (code) => {
    const data = await api.post('/auth/2fa/verify', { code });
    setCsrfToken(data.csrfToken);
    setUser(data.user);
    setMockMode(Boolean(data.mockMode));
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, setUser, mockMode, status, login, verifyMfa, logout, refresh }),
    [user, mockMode, status, login, verifyMfa, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
