import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, onSessionError, setCsrf, type Me } from './api';
import { Button, Field, Modal } from '../components/ui';

interface AuthState {
  me: Me | null;
  refresh: () => Promise<Me>;
  can: (perm: string) => boolean;
  isOwner: boolean;
}

const AuthCtx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    const m = await api.get<Me>('/auth/me');
    setCsrf(m.csrf_token);
    setMe(m);
    return m;
  }, []);
  useEffect(() => { refresh().catch(() => setMe({ authenticated: false })); }, [refresh]);
  // Any request that finds the session or profile locked refreshes state; the router then shows the right screen.
  useEffect(() => onSessionError(() => { refresh().catch(() => undefined); }), [refresh]);
  const can = useCallback((p: string) => !!me?.staff?.permissions.includes(p), [me]);
  return <AuthCtx.Provider value={{ me, refresh, can, isOwner: me?.staff?.role === 'owner' }}>{children}</AuthCtx.Provider>;
}

// ---- "Confirm your password" for sensitive owner actions ----

type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
const ReauthCtx = createContext<Runner>((fn) => fn());
/** Wrap a sensitive call: if the server asks for recent authentication, prompt for the password and retry once. */
export const useSensitive = () => useContext(ReauthCtx);

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = () => new Promise<void>((resolve, reject) => {
    pending.current = { resolve, reject };
    setPassword('');
    setError('');
    setOpen(true);
  });

  const run: Runner = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') {
        await ask();
        return fn();
      }
      throw e;
    }
  }, []);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/reauth', { password });
      setOpen(false);
      pending.current?.resolve();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not confirm.');
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new ApiError(0, 'Cancelled.', 'CANCELLED', {}));
  };

  return (
    <ReauthCtx.Provider value={run}>
      {children}
      {open && (
        <Modal title="Confirm it’s you" onClose={cancel}>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <p className="muted">For your security, enter the business account password to continue.</p>
            <Field label="Business password" error={error}>
              <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <div className="actions">
              <Button variant="ghost" type="button" onClick={cancel}>Cancel</Button>
              <Button type="submit" busy={busy}>Confirm</Button>
            </div>
          </form>
        </Modal>
      )}
    </ReauthCtx.Provider>
  );
}
