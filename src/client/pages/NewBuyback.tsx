import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, type Quote, type Rate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { annotatePhoto, checkPhoto } from '../lib/image';
import { Alert, Button, Card, Field, Loading, Modal, PageHeader, errorMessage } from '../components/ui';
import {
  CALC_ERROR_TEXT, GOLD_PURITIES, ITEM_TYPES, SILVER_PURITIES, computeQuote, formatBp, formatMg, formatPaise, parseGramsToMg, parsePercentToBp,
  validateQuote, bpToPercentString, type Metal,
} from '../../shared/calc';
import { formatIST } from '../../shared/time';

interface Settings { buyback: { default_pct_bp: number; staff_min_pct_bp: number; staff_max_pct_bp: number } }
interface Preview { rate_version_id: string; base_rate_paise: number; applied_rate_paise: number; net_mg: number; assessed_paise: number; offer_paise: number; rate_updated_at: number; rate_updated_by: string }

const newKey = () => crypto.randomUUID();

export function NewBuybackPage() {
  const { me, isOwner } = useAuth();
  const navigate = useNavigate();
  const [rates, setRates] = useState<{ gold: Rate | null; silver: Rate | null } | null>(null);
  const [limits, setLimits] = useState<Settings['buyback'] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [key] = useState(newKey);
  const draftRef = key.replace(/-/g, '').slice(0, 8).toUpperCase();
  const [f, setF] = useState({
    customer_name: '', customer_phone: '', metal: 'gold' as Metal, purity: '22K', item_type: '', description: '',
    gross_weight: '', deduction_weight: '0', buyback_pct: '', override_reason: '', notes: '',
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState('');
  const uploaded = useRef<{ file: File; sig: string; id: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ message: string; prev: number; next: Preview } | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.get<{ gold: Rate | null; silver: Rate | null }>('/rates'), api.get<Settings>('/settings')])
      .then(([r, s]) => {
        setRates(r);
        setLimits(s.buyback);
        setF((x) => ({ ...x, buyback_pct: bpToPercentString(s.buyback.default_pct_bp) }));
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setMetal = (metal: Metal) => setF((x) => ({ ...x, metal, purity: metal === 'gold' ? '22K' : '999' }));

  const rate = rates?.[f.metal] ?? null;
  const grossMg = parseGramsToMg(f.gross_weight);
  const deductionMg = f.deduction_weight.trim() === '' ? 0 : parseGramsToMg(f.deduction_weight);
  const pctBp = parsePercentToBp(f.buyback_pct);
  const calc = useMemo(() => {
    if (!rate || grossMg === null || deductionMg === null || pctBp === null) return null;
    const input = { metal: f.metal, purity: f.purity, grossMg, deductionMg, baseRatePaise: rate.rate_paise, pctBp };
    const err = validateQuote(input);
    return err ? { error: CALC_ERROR_TEXT[err] } : { figures: computeQuote(input) };
  }, [rate, grossMg, deductionMg, pctBp, f.metal, f.purity]);
  const outsideLimits = !!limits && pctBp !== null && (pctBp < limits.staff_min_pct_bp || pctBp > limits.staff_max_pct_bp);

  const choosePhoto = async (file: File | undefined) => {
    setPhotoError('');
    if (!file) return;
    try {
      await checkPhoto(file);
      setPhoto(file);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(file));
    } catch (e) { setPhotoError(errorMessage(e)); }
  };
  const retake = () => { setPhoto(null); if (preview) URL.revokeObjectURL(preview); setPreview(null); uploaded.current = null; };

  /** Uploads the annotated photo, re-using an earlier upload if nothing on the caption changed. */
  const ensurePhoto = async (): Promise<string> => {
    if (!photo || !calc || !('figures' in calc) || !calc.figures) throw new Error('Take a photo first.');
    const metalLabel = f.metal === 'gold' ? 'Gold' : 'Silver';
    const lines = [
      `Swarna Live · Ref ${draftRef} · ${formatIST(Date.now())}`,
      `${metalLabel} ${f.purity} · Gross ${formatMg(grossMg!)} · Less ${formatMg(deductionMg!)} · Net ${formatMg(calc.figures.netMg)}`,
    ];
    const sig = `${f.metal}|${f.purity}|${grossMg}|${deductionMg}`;
    if (uploaded.current && uploaded.current.file === photo && uploaded.current.sig === sig) return uploaded.current.id;
    const blob = await annotatePhoto(photo, { lines });
    const r = await api.upload<{ id: string }>('/photos', blob);
    uploaded.current = { file: photo, sig, id: r.id };
    return r.id;
  };

  const submit = async (override?: Preview) => {
    setError('');
    if (!f.customer_name.trim()) return setError('Enter the customer’s name.');
    if (!f.customer_phone.trim()) return setError('Enter the customer’s phone number.');
    if (!f.item_type) return setError('Choose the item type.');
    if (!rate) return setError(`No ${f.metal} rate has been entered yet.`);
    if (!calc || !('figures' in calc) || !calc.figures) return setError(calc && 'error' in calc ? calc.error! : 'Check the weights and percentage.');
    if (outsideLimits && !isOwner) return setError(`Buyback percentage must be between ${formatBp(limits!.staff_min_pct_bp)} and ${formatBp(limits!.staff_max_pct_bp)}.`);
    if (outsideLimits && isOwner && !f.override_reason.trim()) return setError('Give a reason for going outside the staff percentage limits.');
    if (!photo) return setError('A photo of the jewellery with the scale reading is required.');
    setBusy(true);
    try {
      const photoId = await ensurePhoto();
      const res = await api.post<{ quote: Quote }>('/quotes', {
        idempotency_key: key, draft_ref: draftRef, photo_id: photoId,
        customer_name: f.customer_name, customer_phone: f.customer_phone, metal: f.metal, purity: f.purity, item_type: f.item_type,
        description: f.description, gross_weight: f.gross_weight, deduction_weight: f.deduction_weight || '0', buyback_pct: f.buyback_pct,
        override_reason: outsideLimits ? f.override_reason : undefined, notes: f.notes,
        rate_version_id: override?.rate_version_id ?? rate.id,
        expected_offer_paise: override?.offer_paise ?? calc.figures.offerPaise,
      });
      navigate(`/transactions/${res.quote.id}`, { state: { saved: true } });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'RATE_CHANGED' || e.code === 'OFFER_MISMATCH')) {
        const next = e.data.current as Preview;
        setReview({ message: e.message, prev: calc.figures.offerPaise, next });
      } else if (e instanceof ApiError && e.code === 'PHOTO_REQUIRED') {
        uploaded.current = null;
        setError(e.message);
      } else setError(errorMessage(e));
    } finally { setBusy(false); }
  };

  const acceptReview = () => {
    if (!review) return;
    // Show the new business-entered rate on the form, then save with exactly the offer the user has reviewed.
    setRates((r) => r && { ...r, [f.metal]: { ...(r[f.metal] as Rate), id: review.next.rate_version_id, rate_paise: review.next.base_rate_paise, created_at: review.next.rate_updated_at, created_by_name: review.next.rate_updated_by } });
    const next = review.next;
    setReview(null);
    submit(next);
  };

  if (loadError) return <Alert kind="error">{loadError}</Alert>;
  if (!rates || !limits) return <Loading />;
  if (!me?.staff?.permissions.includes('quotes.create')) return <Alert kind="error">Your profile cannot create buyback quotes.</Alert>;
  const purities = f.metal === 'gold' ? GOLD_PURITIES : SILVER_PURITIES;
  const figures = calc && 'figures' in calc ? calc.figures : null;

  return (
    <>
      <PageHeader title="New Buyback" subtitle={<>Estimate reference <strong>{draftRef}</strong>. The order number is given when you save.</>} />
      <form className="buyback" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(); }} noValidate>
        <div className="buyback-main">
          <Card>
            <h2>Customer</h2>
            <div className="grid-2">
              <Field label="Customer name"><input value={f.customer_name} onChange={set('customer_name')} autoComplete="off" required /></Field>
              <Field label="Phone number" prefix="+91" help="10-digit mobile. +91 is added automatically.">
                <input type="tel" inputMode="tel" value={f.customer_phone} onChange={set('customer_phone')} autoComplete="off" required />
              </Field>
            </div>
          </Card>

          <Card>
            <h2>Item</h2>
            <fieldset className="segmented-field">
              <legend>Metal</legend>
              <div className="segmented">
                {(['gold', 'silver'] as Metal[]).map((m) => (
                  <label key={m} className={f.metal === m ? 'on' : ''}><input type="radio" name="metal" value={m} checked={f.metal === m} onChange={() => setMetal(m)} />{m === 'gold' ? 'Gold' : 'Silver'}</label>
                ))}
              </div>
            </fieldset>
            <fieldset className="segmented-field">
              <legend>Purity</legend>
              <div className="segmented">
                {purities.map((p) => (
                  <label key={p} className={f.purity === p ? 'on' : ''}><input type="radio" name="purity" value={p} checked={f.purity === p} onChange={() => setF((x) => ({ ...x, purity: p }))} />{p}</label>
                ))}
              </div>
            </fieldset>
            <div className="grid-2">
              <Field label="Item type">
                <select value={f.item_type} onChange={set('item_type')} required>
                  <option value="">Choose…</option>
                  {ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Item description" optional><input value={f.description} onChange={set('description')} placeholder="e.g. chain with pendant, 2 stones" /></Field>
            </div>
          </Card>

          <Card>
            <h2>Weight and percentage</h2>
            <p className="muted small">Read the weights from your scale and type them in (grams, up to 3 decimals).</p>
            <div className="grid-3">
              <Field label="Gross weight (g)"><input inputMode="decimal" value={f.gross_weight} onChange={set('gross_weight')} placeholder="0.000" required /></Field>
              <Field label="Stone / other deduction (g)"><input inputMode="decimal" value={f.deduction_weight} onChange={set('deduction_weight')} placeholder="0.000" /></Field>
              <Field label="Buyback %" help={`Staff limit ${formatBp(limits.staff_min_pct_bp)}–${formatBp(limits.staff_max_pct_bp)}`}>
                <input inputMode="decimal" value={f.buyback_pct} onChange={set('buyback_pct')} required />
              </Field>
            </div>
            {outsideLimits && isOwner ? (
              <Field label="Reason for owner override" help="Recorded in the audit history."><input value={f.override_reason} onChange={set('override_reason')} required /></Field>
            ) : outsideLimits ? <Alert kind="warning">This percentage is outside your limit. Ask the owner.</Alert> : null}
            <Field label="Notes" optional><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
          </Card>

          <Card>
            <h2>Photograph <span className="req">required</span></h2>
            <p className="muted small">Take one clear photo showing the jewellery <strong>and the scale reading together</strong>. The photo is a record only; it does not check weight or purity.</p>
            {preview ? (
              <figure className="photo-preview">
                <img src={preview} alt="Selected jewellery photograph" />
                <figcaption>A caption strip with the reference, weights, purity and IST time is added when you save.</figcaption>
                <Button variant="secondary" type="button" onClick={retake}>Retake photo</Button>
              </figure>
            ) : (
              <div className="photo-buttons">
                <Button type="button" size="lg" variant="gold" onClick={() => cameraInput.current?.click()}>📷 Take photo</Button>
                <Button type="button" size="lg" variant="secondary" onClick={() => fileInput.current?.click()}>Upload from device</Button>
              </div>
            )}
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { choosePhoto(e.target.files?.[0]); e.target.value = ''; }} />
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden onChange={(e) => { choosePhoto(e.target.files?.[0]); e.target.value = ''; }} />
            {photoError ? <Alert kind="error">{photoError}</Alert> : null}
          </Card>
        </div>

        <aside className="buyback-summary">
          <Card className="summary-card">
            <h2>Estimate</h2>
            {!rate ? (
              <Alert kind="warning">No business-entered {f.metal} rate yet. {isOwner || me.staff.permissions.includes('rates.update') ? 'Set it in Settings → Rates.' : 'Ask the owner to set it.'}</Alert>
            ) : (
              <>
                <div className="rate-line">
                  <span className="tag">Business-entered rate</span>
                  <div>{f.metal === 'gold' ? '24K' : 'Silver 999'}: <strong>{formatPaise(rate.rate_paise)}/g</strong></div>
                  <div className="muted small">Updated {formatIST(rate.created_at)} by {rate.created_by_name}</div>
                </div>
                <dl className="figures">
                  <dt>Net weight</dt><dd>{figures ? formatMg(figures.netMg) : '—'}</dd>
                  <dt>Rate for {f.purity}</dt><dd>{figures ? `${formatPaise(figures.appliedRatePaise)}/g` : '—'}</dd>
                  <dt>Assessed value</dt><dd>{figures ? formatPaise(figures.assessedPaise) : '—'}</dd>
                  <dt>Buyback %</dt><dd>{pctBp !== null ? formatBp(pctBp) : '—'}</dd>
                </dl>
                <div className="offer">
                  <span>Estimated customer offer</span>
                  <strong>{figures ? formatPaise(figures.offerPaise) : '—'}</strong>
                </div>
                {calc && 'error' in calc ? <p className="error-text">{calc.error}</p> : null}
              </>
            )}
            <p className="muted small">This is a buyback estimate, not a payment. Final value is subject to physical inspection and purity confirmation.</p>
            {error ? <Alert kind="error">{error}</Alert> : null}
            <Button type="submit" size="lg" className="full" busy={busy} disabled={!rate}>Save estimate</Button>
          </Card>
        </aside>
      </form>

      {review && (
        <Modal title="Please review the updated offer" onClose={() => setReview(null)}>
          <p>{review.message}</p>
          <dl className="figures">
            <dt>Offer you saw</dt><dd><s>{formatPaise(review.prev)}</s></dd>
            <dt>Rate now</dt><dd>{formatPaise(review.next.base_rate_paise)}/g ({f.metal === 'gold' ? '24K' : '999'}) · {formatPaise(review.next.applied_rate_paise)}/g for {f.purity}</dd>
            <dt>Updated</dt><dd>{formatIST(review.next.rate_updated_at)} by {review.next.rate_updated_by}</dd>
            <dt>Assessed value</dt><dd>{formatPaise(review.next.assessed_paise)}</dd>
          </dl>
          <div className="offer"><span>Updated estimated offer</span><strong>{formatPaise(review.next.offer_paise)}</strong></div>
          <div className="actions">
            <Button variant="ghost" onClick={() => setReview(null)}>Go back</Button>
            <Button onClick={acceptReview}>Save with updated offer</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
