import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Brand } from '../components/Layout';
import { Alert, Button, Field, Loading, errorMessage } from '../components/ui';
import { ROLE_LABEL, type Role } from '../../shared/permissions';

function AuthFrame({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className={`auth-card ${wide ? 'auth-wide' : ''}`}>
        <div className="auth-brand"><Brand /></div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

const pinOk = (p: string) => /^\d{6}$/.test(p);

// ---------- login ----------
export function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/auth/login', { email, password });
      await refresh();
      navigate('/profiles', { replace: true });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="Sign in to your business">
      <form onSubmit={submit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Business email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button type="submit" size="lg" busy={busy} className="full">Sign in</Button>
      </form>
      <p className="auth-links"><Link to="/recover">Lost the password? Use a recovery code</Link></p>
    </AuthFrame>
  );
}

// ---------- recovery codes shown once ----------
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const download = () => {
    const text = `Swarna Live owner recovery codes\nCreated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\nEach code works once.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'swarna-live-recovery-codes.txt'; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="recovery">
      <Alert kind="warning">
        <strong>Save these recovery codes now. They will not be shown again.</strong> If you forget the business password,
        one code lets you set a new one. Each code works once. Keep them somewhere safe, away from this device.
      </Alert>
      <ol className="codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
      <div className="actions">
        <Button variant="secondary" type="button" onClick={download}>Download</Button>
        <Button variant="secondary" type="button" onClick={() => window.print()}>Print</Button>
        <Button variant="secondary" type="button" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</Button>
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes somewhere safe</label>
      <Button size="lg" className="full" disabled={!saved} onClick={onDone}>Continue</Button>
    </div>
  );
}

// ---------- first owner setup ----------
function OwnerForm({ invite }: { invite?: string }) {
  const [f, setF] = useState({ setup_token: '', business_name: '', owner_name: '', email: '', password: '', password2: '', pin: '', pin2: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (f.password !== f.password2) return setError('The two passwords do not match.');
    if (!pinOk(f.pin) || f.pin !== f.pin2) return setError('Enter the same 6-digit PIN twice.');
    setBusy(true);
    try {
      const r = invite
        ? await api.post<{ recovery_codes: string[] }>('/setup/invite', { invite_token: invite, owner_name: f.owner_name, password: f.password, pin: f.pin })
        : await api.post<{ recovery_codes: string[] }>('/setup', { setup_token: f.setup_token, business_name: f.business_name, owner_name: f.owner_name, email: f.email, password: f.password, pin: f.pin });
      setCodes(r.recovery_codes);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  // Full page load: the signed-in app starts cleanly on Settings (rates are the first thing to set).
  if (codes) return <RecoveryCodes codes={codes} onDone={() => window.location.assign('/settings/rates')} />;
  return (
    <form onSubmit={submit} noValidate>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {!invite && (
        <>
          <Field label="Setup code" help="The one-time code from your Cloudflare settings (the SETUP_TOKEN secret)."><input value={f.setup_token} onChange={set('setup_token')} autoComplete="off" required autoFocus /></Field>
          <Field label="Business name"><input value={f.business_name} onChange={set('business_name')} required /></Field>
        </>
      )}
      <Field label="Your name"><input value={f.owner_name} onChange={set('owner_name')} autoComplete="name" required autoFocus={!!invite} /></Field>
      {!invite && <Field label="Business email (used to sign in)"><input type="email" value={f.email} onChange={set('email')} autoComplete="username" required /></Field>}
      <div className="grid-2">
        <Field label="Password" help="At least 10 characters."><input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={10} /></Field>
        <Field label="Repeat password"><input type="password" value={f.password2} onChange={set('password2')} autoComplete="new-password" required /></Field>
      </div>
      <div className="grid-2">
        <Field label="Your 6-digit PIN" help="Unlocks your owner profile."><input inputMode="numeric" pattern="\d{6}" maxLength={6} type="password" value={f.pin} onChange={set('pin')} autoComplete="off" required /></Field>
        <Field label="Repeat PIN"><input inputMode="numeric" pattern="\d{6}" maxLength={6} type="password" value={f.pin2} onChange={set('pin2')} autoComplete="off" required /></Field>
      </div>
      <Button type="submit" size="lg" busy={busy} className="full">Create owner account</Button>
    </form>
  );
}

export function SetupPage() {
  return <AuthFrame title="Set up Swarna Live" wide><p className="muted">Create the owner account. This can only be done once.</p><OwnerForm /></AuthFrame>;
}

export function InvitePage() {
  const token = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
  return (
    <AuthFrame title="Accept your invitation" wide>
      {token ? <OwnerForm invite={token} /> : <Alert kind="error">This invitation link is incomplete. Open the full link you were given.</Alert>}
    </AuthFrame>
  );
}

// ---------- recovery ----------
export function RecoverPage() {
  const [f, setF] = useState({ email: '', code: '', new_password: '', new_password2: '', new_pin: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (f.new_password !== f.new_password2) return setError('The two passwords do not match.');
    if (f.new_pin && !pinOk(f.new_pin)) return setError('The new PIN must be 6 digits.');
    setBusy(true);
    try {
      const r = await api.post<{ recovery_codes: string[] }>('/auth/recover', { email: f.email, code: f.code, new_password: f.new_password, new_pin: f.new_pin || undefined });
      setCodes(r.recovery_codes);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  if (codes) {
    return (
      <AuthFrame title="Your new recovery codes" wide>
        <p>Your password has been changed and you have been signed out everywhere else. All old recovery codes have stopped working.</p>
        <RecoveryCodes codes={codes} onDone={() => window.location.assign('/')} />
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Recover the owner account">
      <p className="muted">Use one of the recovery codes you saved when Swarna Live was set up.</p>
      <form onSubmit={submit} noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Business email"><input type="email" value={f.email} onChange={set('email')} autoComplete="username" required autoFocus /></Field>
        <Field label="Recovery code" help="Looks like ABCD-EFGH-JKLM-NPQR."><input value={f.code} onChange={set('code')} autoComplete="off" autoCapitalize="characters" required /></Field>
        <Field label="New password" help="At least 10 characters."><input type="password" value={f.new_password} onChange={set('new_password')} autoComplete="new-password" required /></Field>
        <Field label="Repeat new password"><input type="password" value={f.new_password2} onChange={set('new_password2')} autoComplete="new-password" required /></Field>
        <Field label="New owner PIN" optional help="Only if you also forgot your 6-digit PIN."><input inputMode="numeric" maxLength={6} type="password" value={f.new_pin} onChange={set('new_pin')} autoComplete="off" /></Field>
        <Button type="submit" size="lg" busy={busy} className="full">Recover account</Button>
      </form>
      <p className="auth-links"><Link to="/login">Back to sign in</Link></p>
    </AuthFrame>
  );
}

// ---------- profile selector + PIN ----------
interface Profile { id: string; name: string; role: Role; locked_until: number | null }

function PinPad({ value, onChange, onSubmit, busy }: { value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean }) {
  const press = (d: string) => { if (value.length < 6) onChange(value + d); };
  return (
    <div className="pinpad">
      <div className="pin-dots" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i} className={i < value.length ? 'on' : ''} />)}</div>
      <input className="sr-only-input" type="password" inputMode="numeric" autoComplete="off" aria-label="6-digit PIN" maxLength={6} value={value} autoFocus
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }} />
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button type="button" key={d} onClick={() => press(d)}>{d}</button>)}
        <button type="button" onClick={() => onChange(value.slice(0, -1))} aria-label="Delete last digit">⌫</button>
        <button type="button" onClick={() => press('0')}>0</button>
        <button type="button" className="pin-go" onClick={onSubmit} disabled={value.length !== 6 || busy} aria-label="Unlock">{busy ? '…' : '→'}</button>
      </div>
    </div>
  );
}

export function ProfilesPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [chosen, setChosen] = useState<Profile | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => { api.get<Profile[]>('/staff/profiles').then(setProfiles).catch((e) => setError(errorMessage(e))); }, []);

  const unlock = async () => {
    if (!chosen || pin.length !== 6) return;
    setBusy(true); setError('');
    try {
      const r = await api.post<{ pin_must_change: boolean }>('/staff/unlock', { staff_id: chosen.id, pin });
      await refresh();
      navigate(r.pin_must_change ? '/change-pin' : '/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
      if (e instanceof ApiError && e.code === 'PIN_LOCKED') api.get<Profile[]>('/staff/profiles').then(setProfiles).catch(() => undefined);
    } finally { setBusy(false); }
  };
  const logout = async () => { await api.post('/auth/logout').catch(() => undefined); await refresh(); navigate('/login', { replace: true }); };

  return (
    <AuthFrame title={chosen ? `Hello, ${chosen.name}` : 'Who is using Swarna Live?'} wide>
      <p className="muted">{me?.business?.name}</p>
      {me?.locked_reason === 'inactive' && !chosen ? <Alert kind="info">The profile was locked after a period of inactivity.</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {!profiles ? <Loading /> : !chosen ? (
        <ul className="profiles">
          {profiles.map((p) => (
            <li key={p.id}>
              <button className="profile" onClick={() => { setChosen(p); setPin(''); setError(''); }} disabled={!!p.locked_until && p.locked_until > Date.now()}>
                <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="profile-name">{p.name}</span>
                <span className="profile-role">{ROLE_LABEL[p.role]}{p.locked_until && p.locked_until > Date.now() ? ' · locked' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : forgot ? (
        <OwnerPinReset onDone={() => { setForgot(false); setError(''); }} />
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); unlock(); }}>
          <p>Enter your 6-digit PIN.</p>
          <PinPad value={pin} onChange={setPin} onSubmit={unlock} busy={busy} />
          <div className="actions center">
            <Button variant="ghost" type="button" onClick={() => setChosen(null)}>Choose a different profile</Button>
            {chosen.role === 'owner' ? <Button variant="ghost" type="button" onClick={() => setForgot(true)}>Forgot owner PIN?</Button> : null}
          </div>
        </form>
      )}
      <hr />
      <div className="actions center"><Button variant="secondary" onClick={logout}>Log out of business account</Button></div>
    </AuthFrame>
  );
}

function OwnerPinReset({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try { await api.post('/staff/owner-pin-reset', { password, new_pin: pin }); setOk(true); } catch (err) { setError(errorMessage(err)); }
  };
  if (ok) return <><Alert kind="success">Owner PIN changed. Enter it to unlock.</Alert><Button onClick={onDone}>Continue</Button></>;
  return (
    <form onSubmit={submit}>
      <p className="muted">Enter the business password to set a new owner PIN.</p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Field label="Business password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></Field>
      <Field label="New 6-digit PIN"><input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} required /></Field>
      <div className="actions"><Button variant="ghost" type="button" onClick={onDone}>Back</Button><Button type="submit">Set new PIN</Button></div>
    </form>
  );
}

export function ChangePinPage({ forced = true }: { forced?: boolean }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!pinOk(p1) || p1 !== p2) return setError('Enter the same 6-digit PIN twice.');
    setBusy(true);
    try {
      await api.post('/staff/me/pin', { current_pin: cur || undefined, new_pin: p1 });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="Choose your own PIN">
      {forced ? <p className="muted">The owner set a temporary PIN for you. Choose a new 6-digit PIN that only you know.</p> : null}
      <form onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {!forced && <Field label="Current PIN"><input type="password" inputMode="numeric" maxLength={6} value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>}
        <Field label="New 6-digit PIN"><input type="password" inputMode="numeric" maxLength={6} value={p1} onChange={(e) => setP1(e.target.value)} required autoFocus /></Field>
        <Field label="Repeat new PIN"><input type="password" inputMode="numeric" maxLength={6} value={p2} onChange={(e) => setP2(e.target.value)} required /></Field>
        <Button type="submit" size="lg" className="full" busy={busy}>Save PIN</Button>
      </form>
    </AuthFrame>
  );
}
