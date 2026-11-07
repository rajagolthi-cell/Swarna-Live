import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type AuditEntry, type Quote, type QuoteListItem, type SyncJob } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Loading, Modal, Money, PageHeader, Pagination, StatusBadge, errorMessage } from '../components/ui';
import { ITEM_TYPES, formatBp, formatMg, formatPaise } from '../../shared/calc';
import { formatIST } from '../../shared/time';
import { STATUSES, type QuoteStatus } from '../../shared/permissions';

// ---------- dashboard ----------
interface Dash { recent: QuoteListItem[]; metrics?: { total_quotes: number; today_quotes: number; total_offers_paise: number } }
interface GoogleStatus { configured: boolean; connection: { status: string; google_email: string | null; last_sync_at: number | null } | null; counts: Record<string, Record<string, number>>; not_backed_up: number }

export function DashboardPage() {
  const { me, isOwner, can } = useAuth();
  const [d, setD] = useState<Dash | null>(null);
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<Dash>('/dashboard').then(setD).catch((e) => setError(errorMessage(e)));
    if (isOwner) api.get<GoogleStatus>('/google/status').then(setG).catch(() => undefined);
  }, [isOwner]);
  const sum = (k: string) => (g ? (g.counts.drive?.[k] ?? 0) + (g.counts.sheet?.[k] ?? 0) : 0);
  return (
    <>
      <PageHeader title={`Welcome, ${me?.staff?.name ?? ''}`} subtitle={me?.business?.name} />
      {can('quotes.create') && <Link to="/buyback/new" className="btn btn-gold btn-hero">+ New Buyback</Link>}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {d?.metrics && (
        <div className="stats">
          <Card className="stat"><span>Total quotes</span><strong>{d.metrics.total_quotes.toLocaleString('en-IN')}</strong></Card>
          <Card className="stat"><span>Today’s quotes</span><strong>{d.metrics.today_quotes.toLocaleString('en-IN')}</strong></Card>
          <Card className="stat"><span>Total estimated offers</span><strong><Money paise={d.metrics.total_offers_paise} /></strong><small>Excludes cancelled. Estimates, not payments.</small></Card>
        </div>
      )}
      {isOwner && g && (
        <Card className="backup-summary">
          <div>
            <h2>Google backup</h2>
            {!g.connection || g.connection.status === 'disconnected' ? <p>Not connected. Records are safely stored in Swarna Live.</p>
              : g.connection.status === 'reconnect_required' ? <p className="warn">Google access stopped working. Reconnect to resume backups.</p>
                : <p>Connected as {g.connection.google_email}. Last backup {g.connection.last_sync_at ? formatIST(g.connection.last_sync_at) : 'not yet'}.</p>}
            <p className="muted small">Pending {sum('pending')} · Failed {sum('failed')} · Paused {sum('paused')}{g.not_backed_up ? ` · Not backed up ${g.not_backed_up}` : ''}</p>
          </div>
          <Link className="btn btn-secondary" to="/settings/backups">Manage</Link>
        </Card>
      )}
      <Card>
        <div className="card-head"><h2>Recent transactions</h2><Link to="/transactions">View all</Link></div>
        {!d ? <Loading /> : <QuoteTable items={d.recent} compact />}
      </Card>
    </>
  );
}

export function QuoteTable({ items, compact }: { items: QuoteListItem[]; compact?: boolean }) {
  const navigate = useNavigate();
  if (!items.length) return <p className="empty">No transactions yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Order</th><th>Date (IST)</th><th>Customer</th><th>Item</th>{!compact && <th>Staff</th>}<th className="r">Estimated offer</th><th>Status</th></tr></thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id} onClick={() => navigate(`/transactions/${q.id}`)}>
              <td data-label="Order"><Link to={`/transactions/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.order_no}</Link></td>
              <td data-label="Date">{formatIST(q.created_at)}</td>
              <td data-label="Customer">{q.customer_name}{q.customer_phone ? <div className="muted small">{q.customer_phone}</div> : null}</td>
              <td data-label="Item">{q.metal === 'gold' ? 'Gold' : 'Silver'} {q.purity} · {formatMg(q.net_mg)}</td>
              {!compact && <td data-label="Staff">{q.staff_name}</td>}
              <td data-label="Offer" className="r"><Money paise={q.offer_paise} /></td>
              <td data-label="Status"><StatusBadge status={q.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- list ----------
export function TransactionsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ items: QuoteListItem[]; page: number; pages: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ q: params.get('q') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', status: params.get('status') ?? '' });

  useEffect(() => {
    setData(null);
    api.get<typeof data>(`/quotes?${params}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [params]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    Object.entries(form).forEach(([k, v]) => { if (v) p.set(k, v); });
    setParams(p);
  };
  const filterParams = new URLSearchParams([...params].filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="Transactions" subtitle="Buyback estimates. “Accepted” means the customer agreed to the estimate; it does not record a payment."
        actions={can('quotes.export') ? <a className="btn btn-secondary" href={`/api/quotes/export.csv?${filterParams}`} download>Export CSV</a> : null} />
      <Card>
        <form className="filters" onSubmit={apply}>
          <Field label="Search"><input type="search" placeholder="Order no., name or phone" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} /></Field>
          <Field label="From"><input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            </select>
          </Field>
          <Button type="submit">Search</Button>
        </form>
      </Card>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Card>
        {!data ? <Loading /> : (
          <>
            <p className="muted small">{data.total.toLocaleString('en-IN')} found</p>
            <QuoteTable items={data.items} />
            <Pagination page={data.page} pages={data.pages} onPage={(p) => { const n = new URLSearchParams(params); n.set('page', String(p)); setParams(n); }} />
          </>
        )}
      </Card>
    </>
  );
}

// ---------- detail ----------
interface Detail { quote: Quote; original: Record<string, unknown>; audit: AuditEntry[]; backup?: SyncJob[] }

const ACTION_LABEL: Record<string, string> = {
  'quote.created': 'Estimate saved', 'quote.status_changed': 'Status changed', 'quote.corrected': 'Details corrected',
  'quote.percentage_override': 'Owner percentage override',
};

function describeChange(a: AuditEntry) {
  const b = a.before_json ? JSON.parse(a.before_json) : null;
  const af = a.after_json ? JSON.parse(a.after_json) : null;
  if (a.action === 'quote.created') return null;
  if (!af) return null;
  return Object.keys(af).map((k) => <div key={k} className="small"><span className="muted">{k.replace(/_/g, ' ')}:</span> {String(b?.[k] ?? '—')} → <strong>{String(af[k] ?? '—')}</strong></div>);
}

export function TransactionDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { can, isOwner } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'status' | 'correct' | null>(null);
  const load = useCallback(() => api.get<Detail>(`/quotes/${id}`).then(setD).catch((e) => setError(errorMessage(e))), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!d) return <Loading />;
  const q = d.quote;
  return (
    <>
      <PageHeader title={`Order ${q.order_no}`} subtitle={<>{formatIST(q.created_at)} · by {q.staff_name} · <StatusBadge status={q.status} /></>}
        actions={<>
          <Link className="btn btn-secondary" to={`/transactions/${q.id}/receipt`}>Print receipt</Link>
          {can('quotes.update_status') && <Button variant="secondary" onClick={() => setModal('status')}>Change status</Button>}
          {can('quotes.correct') && <Button variant="secondary" onClick={() => setModal('correct')}>Correct details</Button>}
        </>} />
      {(location.state as { saved?: boolean } | null)?.saved ? <Alert kind="success">Estimate saved with its photograph. Order number {q.order_no}.</Alert> : null}
      <div className="detail">
        <Card>
          <h2>Estimate</h2>
          <dl className="figures">
            <dt>Customer</dt><dd>{q.customer_name}<br /><span className="muted">{q.customer_phone}</span></dd>
            <dt>Item</dt><dd>{q.item_type}{q.description ? ` — ${q.description}` : ''}</dd>
            <dt>Metal &amp; purity</dt><dd>{q.metal === 'gold' ? 'Gold' : 'Silver'} {q.purity}</dd>
            <dt>Gross weight</dt><dd>{formatMg(q.gross_mg)}</dd>
            <dt>Deduction</dt><dd>{formatMg(q.deduction_mg)}</dd>
            <dt>Net weight</dt><dd>{formatMg(q.net_mg)}</dd>
            <dt>Business-entered rate</dt><dd>{formatPaise(q.applied_rate_paise)}/g <span className="muted small">({q.metal === 'gold' ? '24K' : '999'} rate {formatPaise(q.base_rate_paise)}/g)</span></dd>
            <dt>Assessed value</dt><dd>{formatPaise(q.assessed_paise)}</dd>
            <dt>Buyback percentage</dt><dd>{formatBp(q.pct_bp)}{q.pct_override ? <span className="tag tag-warn"> owner override</span> : null}</dd>
          </dl>
          <div className="offer"><span>Estimated customer offer</span><strong>{formatPaise(q.offer_paise)}</strong></div>
          {q.override_reason ? <p className="small"><strong>Override reason:</strong> {q.override_reason}</p> : null}
          {q.notes ? <p><strong>Notes:</strong> {q.notes}</p> : null}
          <p className="muted small">Buyback estimate only — not a payment. Final value is subject to physical inspection and purity confirmation.</p>
        </Card>
        <Card>
          <h2>Photograph</h2>
          <figure className="photo-frame">
            <a href={q.photo_url} target="_blank" rel="noopener"><img src={q.photo_url} alt={`Jewellery and scale for order ${q.order_no}`} /></a>
            <figcaption>Order {q.order_no} · photo reference {q.draft_ref} · {q.metal === 'gold' ? 'Gold' : 'Silver'} {q.purity} · net {formatMg(q.net_mg)} · {formatIST(q.created_at)}</figcaption>
          </figure>
          <p className="muted small">The photo is a record. It does not verify weight or purity.</p>
        </Card>
      </div>

      {isOwner && d.backup && (
        <Card>
          <h2>Google backup</h2>
          {d.backup.length === 0 ? <p className="muted">Not backed up (Google was not connected when this was saved). Use “Back up missed records” in Settings → Backups.</p> : (
            <ul className="sync-list">
              {d.backup.map((j) => (
                <li key={j.kind}>
                  <strong>{j.kind === 'drive' ? 'Drive photo' : 'Sheets row'}:</strong> <span className={`sync sync-${j.status}`}>{j.status === 'synced' ? 'Synced' : j.status === 'pending' ? 'Pending' : j.status === 'paused' ? 'Paused (Google disconnected)' : 'Failed'}</span>
                  {j.synced_at ? <span className="muted small"> · {formatIST(j.synced_at)}</span> : null}
                  {j.drive_link ? <> · <a href={j.drive_link} target="_blank" rel="noopener">Open in Drive</a></> : null}
                  {j.last_error && j.status !== 'synced' ? <div className="small error-text">{j.last_error}</div> : null}
                </li>
              ))}
            </ul>
          )}
          {d.backup.some((j) => j.status === 'failed') && <Button variant="secondary" onClick={async () => { await api.post('/google/retry', { quote_id: q.id }); load(); }}>Retry backup</Button>}
        </Card>
      )}

      <Card>
        <h2>History</h2>
        <ol className="history">
          {d.audit.map((a, i) => (
            <li key={i}>
              <div><strong>{ACTION_LABEL[a.action] ?? a.action}</strong> · {formatIST(a.created_at)} · {a.staff_name ?? 'System'}</div>
              {a.reason ? <div className="small">Reason: {a.reason}</div> : null}
              {describeChange(a)}
            </li>
          ))}
        </ol>
        <details><summary>Original values as first saved</summary>
          <p className="small muted">Customer {String(d.original.customer_name)}, {String(d.original.customer_phone)} · {String(d.original.item_type)} · status {String(d.original.status)} · offer {formatPaise(Number(d.original.offer_paise))}</p>
        </details>
      </Card>

      {modal === 'status' && <StatusModal quote={q} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {modal === 'correct' && <CorrectModal quote={q} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </>
  );
}

function StatusModal({ quote, onClose, onDone }: { quote: Quote; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<QuoteStatus>(quote.status === 'estimated' ? 'accepted' : 'estimated');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/quotes/${quote.id}/status`, { status, reason }); onDone(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Change status" onClose={onClose}>
      <form onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="New status" help="“Accepted” means the customer agreed to the estimate. It does not mean money was paid.">
          <select value={status} onChange={(e) => setStatus(e.target.value as QuoteStatus)}>
            {STATUSES.filter((s) => s !== quote.status).map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
        <div className="actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function CorrectModal({ quote, onClose, onDone }: { quote: Quote; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ customer_name: quote.customer_name, customer_phone: quote.customer_phone, item_type: quote.item_type, description: quote.description ?? '', notes: quote.notes ?? '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    const body: Record<string, string> = { reason: f.reason };
    (['customer_name', 'customer_phone', 'item_type', 'description', 'notes'] as const).forEach((k) => {
      const orig = (quote[k] ?? '') as string;
      if (f[k] !== orig) body[k] = f[k];
    });
    try { await api.post(`/quotes/${quote.id}/correct`, body); onDone(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Correct details" onClose={onClose} wide>
      <form onSubmit={submit}>
        <p className="muted small">Weights, rate, percentage and offer cannot be changed. If they are wrong, cancel this estimate and create a new one.</p>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="grid-2">
          <Field label="Customer name"><input value={f.customer_name} onChange={set('customer_name')} /></Field>
          <Field label="Phone number"><input value={f.customer_phone} onChange={set('customer_phone')} /></Field>
          <Field label="Item type"><select value={f.item_type} onChange={set('item_type')}>{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Description"><input value={f.description} onChange={set('description')} /></Field>
        </div>
        <Field label="Notes"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        <Field label="Reason for the correction"><input value={f.reason} onChange={set('reason')} required /></Field>
        <div className="actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Save correction</Button></div>
      </form>
    </Modal>
  );
}

// ---------- receipt (print layout, no navigation) ----------
interface BizSettings { business: { name: string; phone: string | null; email: string | null; address: string | null; gstin: string | null; has_logo: boolean } }

export function ReceiptPage() {
  const { id } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [b, setB] = useState<BizSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api.get<Detail>(`/quotes/${id}`), api.get<BizSettings>('/settings')]).then(([x, y]) => { setD(x); setB(y); }).catch((e) => setError(errorMessage(e)));
  }, [id]);
  if (error) return <div className="receipt-page"><Alert kind="error">{error}</Alert></div>;
  if (!d || !b) return <Loading />;
  const q = d.quote;
  const biz = b.business;
  return (
    <div className="receipt-page">
      <div className="no-print receipt-tools">
        <Link className="btn btn-ghost" to={`/transactions/${q.id}`}>‹ Back</Link>
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <article className="receipt">
        <header className="receipt-head">
          {biz.has_logo ? <img className="receipt-logo" src="/api/settings/logo" alt={`${biz.name} logo`} /> : null}
          <div>
            <h1>{biz.name}</h1>
            <p>{[biz.address, biz.phone, biz.email].filter(Boolean).join(' · ')}{biz.gstin ? ` · GSTIN ${biz.gstin}` : ''}</p>
          </div>
          <div className="receipt-brand">Swarna Live</div>
        </header>
        <h2 className="receipt-title">Jewellery Buyback Estimate</h2>
        <p className="receipt-notice">This is an estimate, not a receipt of payment.</p>
        <table className="receipt-table">
          <tbody>
            <tr><th>Order number</th><td>{q.order_no}</td><th>Date &amp; time</th><td>{formatIST(q.created_at)}</td></tr>
            <tr><th>Customer</th><td>{q.customer_name}</td><th>Phone</th><td>{q.customer_phone}</td></tr>
            <tr><th>Item</th><td colSpan={3}>{q.item_type}{q.description ? ` — ${q.description}` : ''}</td></tr>
            <tr><th>Metal &amp; purity</th><td>{q.metal === 'gold' ? 'Gold' : 'Silver'} {q.purity}</td><th>Status</th><td>{q.status === 'accepted' ? 'Accepted (estimate agreed; not a payment)' : q.status[0].toUpperCase() + q.status.slice(1)}</td></tr>
            <tr><th>Gross weight</th><td>{formatMg(q.gross_mg)}</td><th>Deduction</th><td>{formatMg(q.deduction_mg)}</td></tr>
            <tr><th>Net weight</th><td>{formatMg(q.net_mg)}</td><th>Business-entered rate</th><td>{formatPaise(q.applied_rate_paise)} per gram</td></tr>
            <tr><th>Assessed value</th><td>{formatPaise(q.assessed_paise)}</td><th>Buyback percentage</th><td>{formatBp(q.pct_bp)}</td></tr>
          </tbody>
        </table>
        <div className="receipt-offer"><span>Estimated customer offer</span><strong>{formatPaise(q.offer_paise)}</strong></div>
        {q.notes ? <p><strong>Notes:</strong> {q.notes}</p> : null}
        <p><strong>Prepared by:</strong> {q.staff_name}</p>
        <p className="receipt-disclaimer">Final value is subject to physical inspection and purity confirmation.</p>
        <p className="receipt-foot">Buyback estimate generated with Swarna Live. Not proof of payment.</p>
      </article>
    </div>
  );
}
