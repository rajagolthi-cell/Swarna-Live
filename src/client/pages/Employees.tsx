import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth, useSensitive } from '../lib/auth';
import { Alert, Button, Card, Field, Loading, Modal, PageHeader, errorMessage } from '../components/ui';
import { DEFAULT_PERMISSIONS, GRANTABLE, PERMISSIONS, ROLE_LABEL, type Permission, type Role } from '../../shared/permissions';

interface StaffItem { id: string; name: string; role: Role; permissions: string[]; disabled: boolean; pin_must_change: boolean; locked_until: number | null }

export function EmployeesPage() {
  const { isOwner } = useAuth();
  const sensitive = useSensitive();
  const [list, setList] = useState<StaffItem[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<StaffItem | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<StaffItem | null>(null);
  const load = useCallback(() => api.get<StaffItem[]>('/staff').then(setList).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => { if (isOwner) load(); }, [isOwner, load]);
  if (!isOwner) return <Alert kind="info">Only the owner can manage staff profiles.</Alert>;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setError(''); setNotice('');
    try { await sensitive(fn); setNotice(msg); load(); } catch (e) { if (!(e instanceof Error && e.message === 'Cancelled.')) setError(errorMessage(e)); }
  };

  return (
    <>
      <PageHeader title="Employees" subtitle="Staff profiles, roles and PINs." actions={<Button onClick={() => setEditing('new')}>+ Add staff</Button>} />
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {!list ? <Loading /> : (
        <div className="staff-grid">
          {list.map((s) => (
            <Card key={s.id} className={s.disabled ? 'disabled' : ''}>
              <div className="staff-head">
                <span className="avatar" aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span>
                <div><h2>{s.name}</h2><span className="muted">{ROLE_LABEL[s.role]}{s.disabled ? ' · Disabled' : ''}{s.pin_must_change ? ' · Must set new PIN' : ''}{s.locked_until ? ' · PIN locked' : ''}</span></div>
              </div>
              {s.role === 'owner' ? <p className="small muted">Full access to everything.</p> : (
                <ul className="perm-list">{s.permissions.length ? s.permissions.map((p) => <li key={p}>{PERMISSIONS[p as Permission] ?? p}</li>) : <li className="muted">No permissions</li>}</ul>
              )}
              {s.role !== 'owner' && (
                <div className="actions wrap">
                  <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button>
                  <Button variant="secondary" onClick={() => setPinFor(s)}>Reset PIN</Button>
                  <Button variant="secondary" onClick={() => act(() => api.post(`/staff/${s.id}/revoke`), `${s.name} has been signed out on every device.`)}>Sign out everywhere</Button>
                  {s.disabled
                    ? <Button variant="secondary" onClick={() => act(() => api.post(`/staff/${s.id}/enable`), `${s.name} enabled.`)}>Enable</Button>
                    : <Button variant="danger" onClick={() => { if (confirm(`Disable ${s.name}? They will be signed out and cannot unlock their profile.`)) act(() => api.post(`/staff/${s.id}/disable`, {}), `${s.name} disabled.`); }}>Disable</Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {editing && <StaffModal staff={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setNotice(m); load(); }} />}
      {pinFor && <ResetPinModal staff={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); setNotice(`Temporary PIN set for ${pinFor.name}. They must choose a new PIN when they next unlock.`); load(); }} />}
    </>
  );
}

function StaffModal({ staff, onClose, onSaved }: { staff: StaffItem | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const sensitive = useSensitive();
  const [name, setName] = useState(staff?.name ?? '');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>(staff && staff.role !== 'owner' ? staff.role : 'employee');
  const [perms, setPerms] = useState<string[]>(staff?.permissions ?? DEFAULT_PERMISSIONS.employee);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const allowed = GRANTABLE[role];
  const changeRole = (r: Exclude<Role, 'owner'>) => { setRole(r); setPerms((p) => p.filter((x) => GRANTABLE[r].includes(x as Permission))); };
  const toggle = (p: string) => setPerms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await sensitive(() => staff ? api.put(`/staff/${staff.id}`, { name, role, permissions: perms }) : api.post('/staff', { name, role, permissions: perms, pin }));
      onSaved(staff ? 'Profile updated.' : `${name} added. Give them the temporary PIN; they will choose their own when they first unlock.`);
    } catch (err) { if (!(err instanceof Error && err.message === 'Cancelled.')) setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title={staff ? `Edit ${staff.name}` : 'Add staff profile'} onClose={onClose} wide>
      <form onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="grid-2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Role">
            <select value={role} onChange={(e) => changeRole(e.target.value as Exclude<Role, 'owner'>)}>
              <option value="employee">Employee</option><option value="admin">Admin</option>
            </select>
          </Field>
        </div>
        <fieldset className="perm-fieldset">
          <legend>Permissions</legend>
          {allowed.map((p) => (
            <label key={p} className="check"><input type="checkbox" checked={perms.includes(p)} onChange={() => toggle(p)} /> {PERMISSIONS[p]}</label>
          ))}
          {role === 'employee' ? <p className="small muted">Employees can never manage staff, settings, Google backups or see business totals.</p> : null}
        </fieldset>
        {!staff && <Field label="Temporary 6-digit PIN" help="Tell the staff member this PIN. They must change it at first unlock."><input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} required /></Field>}
        <div className="actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function ResetPinModal({ staff, onClose, onSaved }: { staff: StaffItem; onClose: () => void; onSaved: () => void }) {
  const sensitive = useSensitive();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try { await sensitive(() => api.post(`/staff/${staff.id}/reset-pin`, { pin })); onSaved(); } catch (err) { if (!(err instanceof Error && err.message === 'Cancelled.')) setError(errorMessage(err)); }
  };
  return (
    <Modal title={`Reset PIN for ${staff.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <p className="muted small">This signs {staff.name} out everywhere. They must choose a new PIN when they next unlock.</p>
        <Field label="Temporary 6-digit PIN"><input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} required autoFocus /></Field>
        <div className="actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit">Set temporary PIN</Button></div>
      </form>
    </Modal>
  );
}
