// Buyback calculations shared by the browser (live preview) and the Worker
// (the only authoritative calculation). All money is integer paise, all
// weights are integer milligrams, percentages are basis points (60% = 6000).
// Rounding: half-up to the nearest paisa at each step.

export type Metal = 'gold' | 'silver';

export const GOLD_PURITIES = ['24K', '22K', '20K', '18K', '14K'] as const;
export const SILVER_PURITIES = ['999'] as const;
export type Purity = (typeof GOLD_PURITIES)[number] | (typeof SILVER_PURITIES)[number];

export const ITEM_TYPES = [
  'Necklace', 'Chain', 'Ring', 'Bangle', 'Bracelet', 'Earrings', 'Pendant', 'Anklet', 'Coin', 'Bar', 'Other',
] as const;

export const MAX_GROSS_MG = 50_000_000; // 50 kg
export const MAX_RATE_PAISE = 100_000_000; // ₹10,00,000 per gram

export function purityAllowed(metal: Metal, purity: string): purity is Purity {
  return metal === 'gold'
    ? (GOLD_PURITIES as readonly string[]).includes(purity)
    : (SILVER_PURITIES as readonly string[]).includes(purity);
}

/** Karat for gold purities (24K → 24). Silver has no karat. */
export function karatOf(purity: string): number | null {
  const m = /^(\d{2})K$/.exec(purity);
  return m ? Number(m[1]) : null;
}

/** Round a non-negative rational a/b half-up to an integer, using BigInt so large values stay exact. */
function divRound(a: bigint, b: bigint): number {
  return Number((a * 2n + b) / (b * 2n));
}

/** Parse "12.345" grams → 12345 mg. Returns null if not a valid non-negative number with ≤ 3 decimals. */
export function parseGramsToMg(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

/** Parse "7250.50" rupees → 725050 paise (≤ 2 decimals). */
export function parseRupeesToPaise(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Parse "60" or "62.5" percent → basis points (6000, 6250). ≤ 2 decimals. */
export function parsePercentToBp(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Applicable rate per gram: gold = 24K rate × karat / 24 (applied once); silver 999 = configured rate. */
export function applicableRatePaise(metal: Metal, purity: string, baseRatePaise: number): number {
  if (metal === 'silver') return baseRatePaise;
  const k = karatOf(purity);
  if (k === null) throw new Error('Invalid gold purity');
  return divRound(BigInt(baseRatePaise) * BigInt(k), 24n);
}

export interface QuoteInput {
  metal: Metal;
  purity: string;
  grossMg: number;
  deductionMg: number;
  baseRatePaise: number;
  pctBp: number;
}

export interface QuoteFigures {
  netMg: number;
  appliedRatePaise: number;
  assessedPaise: number;
  offerPaise: number;
}

export type CalcError =
  | 'GROSS_INVALID' | 'DEDUCTION_INVALID' | 'RATE_INVALID' | 'PERCENT_INVALID' | 'PURITY_INVALID';

export const CALC_ERROR_TEXT: Record<CalcError, string> = {
  GROSS_INVALID: 'Gross weight must be more than 0 g (up to 3 decimals).',
  DEDUCTION_INVALID: 'Deduction must be 0 or more and less than the gross weight.',
  RATE_INVALID: 'The business-entered rate for this metal is missing or invalid.',
  PERCENT_INVALID: 'Buyback percentage must be more than 0 and at most 100.',
  PURITY_INVALID: 'Choose a purity that matches the selected metal.',
};

export function validateQuote(i: QuoteInput): CalcError | null {
  if (!purityAllowed(i.metal, i.purity)) return 'PURITY_INVALID';
  if (!Number.isInteger(i.grossMg) || i.grossMg <= 0 || i.grossMg > MAX_GROSS_MG) return 'GROSS_INVALID';
  if (!Number.isInteger(i.deductionMg) || i.deductionMg < 0 || i.deductionMg >= i.grossMg) return 'DEDUCTION_INVALID';
  if (!Number.isInteger(i.baseRatePaise) || i.baseRatePaise <= 0 || i.baseRatePaise > MAX_RATE_PAISE) return 'RATE_INVALID';
  if (!Number.isInteger(i.pctBp) || i.pctBp <= 0 || i.pctBp > 10000) return 'PERCENT_INVALID';
  return null;
}

/** Throws if the input is invalid; call validateQuote first for a friendly error. */
export function computeQuote(i: QuoteInput): QuoteFigures {
  const err = validateQuote(i);
  if (err) throw new Error(err);
  const netMg = i.grossMg - i.deductionMg;
  const appliedRatePaise = applicableRatePaise(i.metal, i.purity, i.baseRatePaise);
  const assessedPaise = divRound(BigInt(netMg) * BigInt(appliedRatePaise), 1000n);
  const offerPaise = divRound(BigInt(assessedPaise) * BigInt(i.pctBp), 10000n);
  return { netMg, appliedRatePaise, assessedPaise, offerPaise };
}

// ---------- formatting ----------

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatPaise = (p: number) => inr.format(p / 100);
export const formatMg = (mg: number) => `${(mg / 1000).toFixed(3)} g`;
export const formatBp = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
export const paiseToRupeesString = (p: number) => (p / 100).toFixed(2);
export const mgToGramsString = (mg: number) => (mg / 1000).toFixed(3);
export const bpToPercentString = (bp: number) => (bp / 100).toFixed(2).replace(/\.00$/, '');
