import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type AuditEntry, type Rate } from '../lib/api';
import { useAuth, useSensitive } from '../lib/auth';
import { Alert, Button, Card, Field, Loading, PageHeader, errorMessage } from '../components/ui';
import { RecoveryCodes } from './Auth';
import { bpToPercentString, formatPaise, paiseToRupeesString } from '../../shared/calc';
import { formatIST } from '../../shared/time';

interface SettingsData {
  business: { name: string; phone: string | null; email: string | null; address: string | null; gstin: string | null; has_logo: boolean };
  buyback: { default_pct_bp: number; staff_min_pct_bp: number; staff_max_pct_bp: number };
  security?: { profile_lock_minutes: number; session_hours: number };
}

const cancelled = (e: unknown) => e instanceof Error && e.message === 'Cancelled.';

function useSave() {
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'success', text: ok }); return true; } catch (e) { if (!cancelled(e)) setMsg({ kind: 'error', text: errorMessage(e) }); return false; } finally { setBusy(false); }
  };
  const view = msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null;
  return { run, busy, view };
}

export function SettingsPage() {
  const { section = 'general' } = useParams();
  const { isOwner, can } = useAuth();
  const sections: [string, string, boolean][] = [
    ['general', 'Business', true],
    ['rates', 'Rates', can('rates.update') || can('audit.view')],
    ['buyback', 'Buyback rules', isOwner],
    ['security', 'Security', isOwner],
    ['backups', 'Backups & Integrations', isOwner],
    ['audit', 'Audit history', can('audit.view')],
    ['account', 'My profile', true],
  ];
  const visible = sections.filter((s) => s[2]);
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="subnav" aria-label="Settings sections">
        {visible.map(([id, label]) => <NavLink key={id} to={`/settings/${id === 'general' ? '' : id}`} end className={() => (section === id ? 'active' : '')}>{label}</NavLink>)}
      </nav>
      {section === 'general' && <BusinessSection />}
      {section === 'rates' && <RatesSection />}
      {section === 'buyback' && isOwner && <BuybackSection />}
      {section === 'security' && isOwner && <SecuritySection />}
      {section === 'backups' && isOwner && <BackupsSection />}
      {section === 'audit' && can('audit.view') && <AuditSection />}
      {section === 'account' && <AccountSection />}
    </>
  );
}

function useSettings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const load = useCallback(() => api.get<SettingsData>('/settings').then(setS), []);
  useEffect(() => { load(); }, [load]);
  return { s, load };
}

// ---------- business ----------
function BusinessSection() {
  const { can, refresh } = useAuth();
  const { s, load } = useSettings();
  const save = useSave();
  const [f, setF] = useState<SettingsData['business'] | null>(null);
  const [logoKey, setLogoKey] = useState(0);
  useEffect(() => { if (s) setF(s.business); }, [s]);
  if (!f || !s) return <Loading />;
  const editable = can('settings.business');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return save.run(() => Promise.reject(new Error('Logo must be smaller than 1 MB.')), '');
    await save.run(() => api.upload('/settings/logo', file), 'Logo updated.');
    setLogoKey((k) => k + 1); load(); refresh();
  };
  return (
    <Card>
      <h2>Business details</h2>
      <p className="muted small">Shown on receipts.</p>
      {save.view}
      <form onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put('/settings/business', f); await refresh(); }, 'Business details saved.'); }}>
        <fieldset disabled={!editable}>
          <div className="grid-2">
            <Field label="Business name"><input value={f.name} onChange={set('name')} required /></Field>
            <Field label="Phone" optional><input value={f.phone ?? ''} onChange={set('phone')} /></Field>
            <Field label="Email" optional><input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
            <Field label="GSTIN" optional><input value={f.gstin ?? ''} onChange={set('gstin')} /></Field>
          </div>
          <Field label="Address" optional><textarea rows={2} value={f.address ?? ''} onChange={set('address')} /></Field>
          {editable && <Button type="submit" busy={save.busy}>Save</Button>}
        </fieldset>
      </form>
      <h3>Logo</h3>
      {s.business.has_logo ? <img key={logoKey} className="logo-preview" src={`/api/settings/logo?v=${logoKey}`} alt="Business logo" /> : <p className="muted">No logo yet.</p>}
      {editable && (
        <div className="actions wrap">
          <label className="btn btn-secondary file-btn">Upload logo (PNG/JPEG/WEBP, under 1 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadLogo(e.target.files?.[0])} /></label>
          {s.business.has_logo && <Button variant="ghost" onClick={async () => { await save.run(() => api.del('/settings/logo'), 'Logo removed.'); load(); }}>Remove logo</Button>}
        </div>
      )}
    </Card>
  );
}

// ---------- rates ----------
function RatesSection() {
  const { can } = useAuth();
  const [rates, setRates] = useState<{ gold: Rate | null; silver: Rate | null } | null>(null);
  const [history, setHistory] = useState<Rate[]>([]);
  const [gold, setGold] = useState('');
  const [silver, setSilver] = useState('');
  const save = useSave();
  const load = useCallback(async () => {
    const r = await api.get<{ gold: Rate | null; silver: Rate | null }>('/rates');
    setRates(r);
    setGold(r.gold ? paiseToRupeesString(r.gold.rate_paise) : '');
    setSilver(r.silver ? paiseToRupeesString(r.silver.rate_paise) : '');
    setHistory((await api.get<{ items: Rate[] }>('/rates/history')).items);
  }, []);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!rates) return <Loading />;
  const submit = (metal: 'gold' | 'silver', value: string) => async (e: FormEvent) => {
    e.preventDefault();
    if (await save.run(() => api.post('/rates', { metal, rate: value }), `${metal === 'gold' ? 'Gold' : 'Silver'} rate saved.`)) load();
  };
  const editable = can('rates.update');
  const RateCard = ({ metal, label, value, setValue }: { metal: 'gold' | 'silver'; label: string; value: string; setValue: (v: string) => void }) => {
    const r = rates[metal];
    return (
      <form className="rate-form" onSubmit={submit(metal, value)}>
        <Field label={`${label} — price per gram (₹)`} help={r ? `Last updated ${formatIST(r.created_at)} by ${r.created_by_name}` : 'Not set yet. Quotes for this metal are blocked until a rate is entered.'}>
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!editable} required />
        </Field>
        {editable && <Button type="submit" busy={save.busy}>Save {metal} rate</Button>}
      </form>
    );
  };
  return (
    <>
      <Card>
        <h2>Business-entered rates</h2>
        <p className="muted small">Enter today’s rates yourself. Swarna Live never fetches market prices. Gold rates for other purities are worked out as 24K rate × karat ÷ 24. Saved estimates keep the rate they were made with.</p>
        {save.view}
        <div className="grid-2">
          {RateCard({ metal: 'gold', label: '24K gold', value: gold, setValue: setGold })}
          {RateCard({ metal: 'silver', label: '999 silver', value: silver, setValue: setSilver })}
        </div>
      </Card>
      <Card>
        <h2>Rate history</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When (IST)</th><th>Metal</th><th className="r">Rate per gram</th><th>Entered by</th></tr></thead>
            <tbody>{history.map((h) => <tr key={h.id}><td>{formatIST(h.created_at)}</td><td>{h.metal === 'gold' ? 'Gold 24K' : 'Silver 999'}</td><td className="r">{formatPaise(h.rate_paise)}</td><td>{h.created_by_name}</td></tr>)}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------- buyback rules ----------
function BuybackSection() {
  const { s } = useSettings();
  const save = useSave();
  const [f, setF] = useState({ default_pct: '', staff_min_pct: '', staff_max_pct: '' });
  useEffect(() => { if (s) setF({ default_pct: bpToPercentString(s.buyback.default_pct_bp), staff_min_pct: bpToPercentString(s.buyback.staff_min_pct_bp), staff_max_pct: bpToPercentString(s.buyback.staff_max_pct_bp) }); }, [s]);
  if (!s) return <Loading />;
  return (
    <Card>
      <h2>Buyback percentage</h2>
      <p className="muted small">Staff can choose a percentage between the minimum and maximum. As owner you can go outside these limits on a quote by giving a reason; it is recorded in the audit history.</p>
      {save.view}
      <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.put('/settings/buyback', f), 'Buyback rules saved.'); }}>
        <div className="grid-3">
          <Field label="Default %"><input inputMode="decimal" value={f.default_pct} onChange={(e) => setF({ ...f, default_pct: e.target.value })} /></Field>
          <Field label="Staff minimum %"><input inputMode="decimal" value={f.staff_min_pct} onChange={(e) => setF({ ...f, staff_min_pct: e.target.value })} /></Field>
          <Field label="Staff maximum %"><input inputMode="decimal" value={f.staff_max_pct} onChange={(e) => setF({ ...f, staff_max_pct: e.target.value })} /></Field>
        </div>
        <Button type="submit" busy={save.busy}>Save</Button>
      </form>
    </Card>
  );
}

// ---------- security ----------
function SecuritySection() {
  const { s } = useSettings();
  const sensitive = useSensitive();
  const save = useSave();
  const pw = useSave();
  const codesSave = useSave();
  const [f, setF] = useState({ profile_lock_minutes: '', session_hours: '' });
  const [newPw, setNewPw] = useState({ a: '', b: '' });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => { if (s?.security) setF({ profile_lock_minutes: String(s.security.profile_lock_minutes), session_hours: String(s.security.session_hours) }); }, [s]);
  useEffect(() => { api.get<{ remaining: number }>('/auth/recovery-codes').then((r) => setRemaining(r.remaining)).catch(() => undefined); }, [codes]);
  if (!s) return <Loading />;
  return (
    <>
      <Card>
        <h2>Sessions and profile lock</h2>
        {save.view}
        <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.put('/settings/security', { profile_lock_minutes: Number(f.profile_lock_minutes), session_hours: Number(f.session_hours) }), 'Saved. New business sign-ins use the new duration.'); }}>
          <div className="grid-2">
            <Field label="Lock a staff profile after this many idle minutes"><input inputMode="numeric" value={f.profile_lock_minutes} onChange={(e) => setF({ ...f, profile_lock_minutes: e.target.value })} /></Field>
            <Field label="Business sign-in lasts (hours)"><input inputMode="numeric" value={f.session_hours} onChange={(e) => setF({ ...f, session_hours: e.target.value })} /></Field>
          </div>
          <Button type="submit" busy={save.busy}>Save</Button>
        </form>
      </Card>
      <Card>
        <h2>Business password</h2>
        <p className="muted small">Changing it signs out every other device.</p>
        {pw.view}
        <form onSubmit={(e) => { e.preventDefault(); if (newPw.a !== newPw.b) return; pw.run(() => sensitive(() => api.post('/auth/password', { new_password: newPw.a })), 'Password changed. Other devices have been signed out.'); }}>
          <div className="grid-2">
            <Field label="New password" help="At least 10 characters."><input type="password" autoComplete="new-password" value={newPw.a} onChange={(e) => setNewPw({ ...newPw, a: e.target.value })} required /></Field>
            <Field label="Repeat new password" error={newPw.b && newPw.a !== newPw.b ? 'Passwords do not match.' : null}><input type="password" autoComplete="new-password" value={newPw.b} onChange={(e) => setNewPw({ ...newPw, b: e.target.value })} required /></Field>
          </div>
          <Button type="submit" busy={pw.busy}>Change password</Button>
        </form>
      </Card>
      <Card>
        <h2>Owner recovery codes</h2>
        <p className="muted small">{remaining === null ? '' : `${remaining} unused code${remaining === 1 ? '' : 's'} left. `}Creating new codes cancels all old ones.</p>
        {codesSave.view}
        {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : (
          <Button variant="secondary" busy={codesSave.busy} onClick={() => codesSave.run(async () => { const r = await sensitive(() => api.post<{ recovery_codes: string[] }>('/auth/recovery-codes')); setCodes(r.recovery_codes); }, 'New recovery codes created.')}>Create new recovery codes</Button>
        )}
      </Card>
    </>
  );
}

// ---------- backups & integrations ----------
interface GStatus {
  configured: boolean; redirect_uri: string;
  connection: null | { status: 'connected' | 'reconnect_required' | 'disconnected'; google_email: string | null; connected_at: number | null; last_sync_at: number | null; last_error: string | null;
    folder: { id: string; name: string | null; link: string } | null; sheet: { spreadsheet_id: string; title: string | null; sheet_id: number | null; sheet_title: string | null; link: string } | null };
  counts: Record<'drive' | 'sheet', Record<string, number>>; not_backed_up: number;
}
interface Inspect { folder?: { id: string; name: string; link: string }; spreadsheet?: { id: string; title: string; link: string; tabs: { sheet_id: number; title: string; state: 'empty' | 'swarna' | 'other' }[]; suggested_sheet_id: number | null } }

const GOOGLE_RESULT: Record<string, [kind: 'success' | 'error', text: string]> = {
  connected: ['success', 'Google account connected. Now choose where backups should go.'],
  denied: ['error', 'Google connection was cancelled.'],
  missing_permissions: ['error', 'Swarna Live needs both Google Drive and Google Sheets access. Please connect again and tick both boxes.'],
  no_offline_access: ['error', 'Google did not allow ongoing access. Please connect again.'],
  invalid_state: ['error', 'That Google sign-in link was invalid or already used. Please try again.'],
  expired: ['error', 'The Google sign-in took too long. Please try again.'],
  session_mismatch: ['error', 'Please finish the Google sign-in on the same device and owner profile that started it.'],
  exchange_failed: ['error', 'Google sign-in could not be completed. Please try again.'],
};

function BackupsSection() {
  const sensitive = useSensitive();
  const [params, setParams] = useSearchParams();
  const [g, setG] = useState<GStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<[string, string] | null>(null);
  const [folder, setFolder] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [tabChoice, setTabChoice] = useState<string>('new');
  const [newTab, setNewTab] = useState('Swarna Live Transactions');
  const [confirmInit, setConfirmInit] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; checks: { name: string; ok: boolean; message: string }[] } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const s = await api.get<GStatus>('/google/status');
    setG(s);
    if (s.connection?.folder) setFolder((v) => v || s.connection!.folder!.link);
    if (s.connection?.sheet) setSheetUrl((v) => v || s.connection!.sheet!.link);
  }, []);
  useEffect(() => { load().catch((e) => setError(errorMessage(e))); }, [load]);
  useEffect(() => {
    const r = params.get('google');
    if (r && GOOGLE_RESULT[r]) { setNotice(GOOGLE_RESULT[r]); setParams({}, { replace: true }); }
  }, [params, setParams]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(''); setNotice(null);
    try { await fn(); } catch (e) { if (!cancelled(e)) setError(errorMessage(e)); } finally { setBusy(''); }
  };

  if (!g) return error ? <Alert kind="error">{error}</Alert> : <Loading />;
  const c = g.connection;
  const total = (k: string) => (g.counts.drive?.[k] ?? 0) + (g.counts.sheet?.[k] ?? 0);
  const connected = c?.status === 'connected';

  return (
    <>
      <Card>
        <h2>Google Drive and Sheets backup</h2>
        <p className="muted small">Swarna Live keeps every record and photo safely in its own storage. If you connect Google, a copy of each photo goes to your Google Drive folder and a row goes to your Google Sheet. Google is only used for these copies — never for signing in.</p>
        {notice ? <Alert kind={notice[0] as 'success' | 'error'}>{notice[1]}</Alert> : null}
        {error ? <Alert kind="error">{error}</Alert> : null}
        {!g.configured ? (
          <Alert kind="info">Google connection has not been set up for this website yet. Your administrator needs to add the Google OAuth client (see docs/GOOGLE_SETUP.md).</Alert>
        ) : (
          <div className="google-status">
            <div>
              <div className={`status-dot status-${c?.status ?? 'none'}`}>{!c || c.status === 'disconnected' ? 'Not connected' : c.status === 'reconnect_required' ? 'Reconnect needed' : 'Connected'}</div>
              {c?.google_email ? <div>Google account: <strong>{c.google_email}</strong></div> : null}
              {c?.last_sync_at ? <div className="small muted">Last successful backup {formatIST(c.last_sync_at)}</div> : null}
              {c?.status === 'reconnect_required' ? <p className="warn small">Google access was revoked or expired. New records are still saved in Swarna Live; backups are paused until you reconnect.</p> : null}
              {c?.last_error && c.status === 'connected' ? <p className="small error-text">Last problem: {c.last_error}</p> : null}
            </div>
            <div className="actions wrap">
              <Button busy={busy === 'connect'} onClick={() => run('connect', async () => { const r = await sensitive(() => api.post<{ auth_url: string }>('/google/connect')); window.location.assign(r.auth_url); })}>
                {connected ? 'Reconnect Google Account' : 'Connect Google Account'}
              </Button>
              {connected && <Button variant="secondary" busy={busy === 'test'} onClick={() => run('test', async () => setTest(await api.post('/google/test')))}>Test Connection</Button>}
              {c && c.status !== 'disconnected' && <Button variant="danger" busy={busy === 'disc'} onClick={() => { if (confirm('Disconnect Google? Files already in your Drive and Sheet will NOT be deleted. New records will not be backed up until you reconnect.')) run('disc', async () => { await sensitive(() => api.post('/google/disconnect')); await load(); setNotice(['success', 'Google disconnected. Existing Drive files and sheet rows were left untouched.']); }); }}>Disconnect Google Account</Button>}
            </div>
            {test && <ul className="checks">{test.checks.map((x) => <li key={x.name} className={x.ok ? 'ok' : 'bad'}><strong>{x.name}:</strong> {x.message}</li>)}</ul>}
          </div>
        )}
      </Card>

      {connected && (
        <Card>
          <h2>Where should backups go?</h2>
          <p className="muted small">Pasting a link does not give access on its own: Swarna Live checks through Google that your connected account can write there. Changing destinations only affects future backups.</p>
          <form onSubmit={(e) => { e.preventDefault(); run('inspect', async () => { setInspect(await api.post<Inspect>('/google/inspect', { folder, spreadsheet: sheetUrl })); }); }}>
            <Field label="Google Drive folder link" help={<>Swarna Live asks for limited Drive access, so it can only use folders it created. Use the button to create one, then move it anywhere in your Drive if you like.</>}>
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" />
            </Field>
            <Button type="button" variant="secondary" busy={busy === 'folder'} onClick={() => run('folder', async () => { const r = await sensitive(() => api.post<{ link: string }>('/google/folder')); setFolder(r.link); })}>Create a backup folder for me</Button>
            <Field label="Google Sheets spreadsheet link" help="Any spreadsheet your Google account can edit. You can download it as an Excel (.xlsx) file from Google Sheets: File → Download.">
              <input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </Field>
            <Button type="submit" variant="secondary" busy={busy === 'inspect'}>Check links</Button>
          </form>
          {inspect?.spreadsheet && inspect.folder && (
            <form className="dest-confirm" onSubmit={(e) => {
              e.preventDefault();
              run('save', async () => {
                const sheet = tabChoice === 'new' ? { new_title: newTab } : { sheet_id: Number(tabChoice) };
                await sensitive(() => api.post('/google/destinations', { folder, spreadsheet: sheetUrl, sheet, confirm_initialize: confirmInit }));
                await load(); setInspect(null); setNotice(['success', 'Destinations saved.']);
              });
            }}>
              <p>Folder: <strong>{inspect.folder.name}</strong> · Spreadsheet: <strong>{inspect.spreadsheet.title}</strong></p>
              <fieldset>
                <legend>Worksheet (tab) for Swarna Live</legend>
                <label className="check"><input type="radio" name="tab" checked={tabChoice === 'new'} onChange={() => setTabChoice('new')} /> Create a new worksheet named <input className="inline-input" value={newTab} onChange={(e) => setNewTab(e.target.value)} aria-label="New worksheet name" /></label>
                {inspect.spreadsheet.tabs.map((t) => (
                  <label key={t.sheet_id} className={`check ${t.state === 'other' ? 'disabled' : ''}`}>
                    <input type="radio" name="tab" disabled={t.state === 'other'} checked={tabChoice === String(t.sheet_id)} onChange={() => setTabChoice(String(t.sheet_id))} />
                    {t.title} <span className="muted small">{t.state === 'empty' ? '(empty)' : t.state === 'swarna' ? '(already used by Swarna Live)' : '(has other content — cannot be used)'}</span>
                  </label>
                ))}
              </fieldset>
              <label className="check"><input type="checkbox" checked={confirmInit} onChange={(e) => setConfirmInit(e.target.checked)} /> I confirm Swarna Live may write its headings into this worksheet and manage it. Other worksheets are never changed.</label>
              <Button type="submit" busy={busy === 'save'}>Save Destinations</Button>
            </form>
          )}
          {c?.folder || c?.sheet ? (
            <div className="current-dest small">
              {c.folder ? <div>Current folder: <a href={c.folder.link} target="_blank" rel="noopener">{c.folder.name ?? 'Drive folder'}</a></div> : null}
              {c.sheet ? <div>Current sheet: <a href={c.sheet.link} target="_blank" rel="noopener">{c.sheet.title} → {c.sheet.sheet_title}</a></div> : null}
            </div>
          ) : null}
        </Card>
      )}

      {c && (
        <Card>
          <h2>Backup status</h2>
          <div className="stats small-stats">
            <div><span>Pending</span><strong>{total('pending')}</strong></div>
            <div><span>Synced</span><strong>{total('synced')}</strong></div>
            <div><span>Failed</span><strong>{total('failed')}</strong></div>
            <div><span>Paused</span><strong>{total('paused')}</strong></div>
            <div><span>Not backed up</span><strong>{g.not_backed_up}</strong></div>
          </div>
          <div className="actions wrap">
            <Button variant="secondary" disabled={!total('failed')} busy={busy === 'retry'} onClick={() => run('retry', async () => { const r = await api.post<{ retried: number }>('/google/retry'); setNotice(['success', `${r.retried} backup${r.retried === 1 ? '' : 's'} queued again.`]); await load(); })}>Retry Failed Backups</Button>
            {connected && (total('paused') > 0 || g.not_backed_up > 0) && (
              <Button busy={busy === 'backfill'} onClick={() => run('backfill', async () => { const r = await api.post<{ resumed: number; queued: number }>('/google/backfill'); setNotice(['success', `Backing up ${r.resumed + r.queued} item${r.resumed + r.queued === 1 ? '' : 's'} saved while Google was disconnected.`]); await load(); })}>Back up missed records</Button>
            )}
          </div>
        </Card>
      )}
      <BackupGuide />
    </>
  );
}

function BackupGuide() {
  return (
    <Card>
      <h2>Keeping your records safe</h2>
      <ul className="guide">
        <li>All estimates and photos are stored in your private Cloudflare storage. Google copies are extra, not the main record.</li>
        <li><strong>Transactions → Export CSV</strong> downloads a spreadsheet of estimates for your own files.</li>
        <li>Your administrator can make full database and photo backups with the steps in <code>docs/BACKUP_RESTORE.md</code>.</li>
        <li>Keep your owner recovery codes printed and stored away from the shop computer.</li>
      </ul>
    </Card>
  );
}

// ---------- audit ----------
function AuditSection() {
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: AuditEntry[]; has_more: boolean } | null>(null);
  useEffect(() => { setD(null); api.get<{ items: AuditEntry[]; has_more: boolean }>(`/audit?page=${page}`).then(setD).catch(() => undefined); }, [page]);
  return (
    <Card>
      <h2>Audit history</h2>
      {!d ? <Loading /> : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When (IST)</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>{d.items.map((a) => (
                <tr key={a.id}><td>{formatIST(a.created_at)}</td><td>{a.staff_name ?? 'System'}</td><td>{a.action}</td>
                  <td className="small">{a.reason ? <div>Reason: {a.reason}</div> : null}{a.before_json ? <div className="muted">Before: {a.before_json}</div> : null}{a.after_json ? <div>After: {a.after_json}</div> : null}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="actions"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>‹ Newer</Button><Button variant="secondary" disabled={!d.has_more} onClick={() => setPage(page + 1)}>Older ›</Button></div>
        </>
      )}
    </Card>
  );
}

// ---------- my profile: switch / logout / PIN ----------
function AccountSection() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [pin, setPin] = useState(false);
  const switchProfile = async () => { await api.post('/staff/lock').catch(() => undefined); await refresh(); navigate('/profiles'); };
  const logout = async () => { await api.post('/auth/logout').catch(() => undefined); await refresh(); navigate('/login'); };
  return (
    <>
      <Card>
        <h2>{me?.staff?.name}</h2>
        <p className="muted">Signed in to {me?.business?.name} ({me?.owner_email})</p>
        <div className="account-actions">
          <div>
            <Button size="lg" variant="secondary" onClick={switchProfile}>Switch profile</Button>
            <p className="small muted">Locks your profile and returns to the profile list. The business stays signed in on this device.</p>
          </div>
          <div>
            <Button size="lg" variant="danger" onClick={logout}>Log out of business account</Button>
            <p className="small muted">Ends the whole business session on this device. The business password is needed to sign in again.</p>
          </div>
        </div>
      </Card>
      <Card>
        <h2>Your PIN</h2>
        {pin ? <ChangePinInline onDone={() => setPin(false)} /> : <Button variant="secondary" onClick={() => setPin(true)}>Change my PIN</Button>}
      </Card>
    </>
  );
}

function ChangePinInline({ onDone }: { onDone: () => void }): ReactNode {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const save = useSave();
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (await save.run(() => api.post('/staff/me/pin', { current_pin: cur, new_pin: p1 }), 'PIN changed.')) setTimeout(onDone, 1200); }}>
      {save.view}
      <div className="grid-2">
        <Field label="Current PIN"><input type="password" inputMode="numeric" maxLength={6} value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
        <Field label="New 6-digit PIN"><input type="password" inputMode="numeric" maxLength={6} value={p1} onChange={(e) => setP1(e.target.value)} required /></Field>
      </div>
      <Button type="submit" busy={save.busy}>Save PIN</Button>
    </form>
  );
}

