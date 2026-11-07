// All timestamps are stored as UTC epoch milliseconds. Business dates are
// shown and grouped in India Standard Time (Asia/Kolkata, UTC+05:30, no DST).

export const BUSINESS_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const dtFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: BUSINESS_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
});
const dFmt = new Intl.DateTimeFormat('en-IN', { timeZone: BUSINESS_TZ, day: '2-digit', month: 'short', year: 'numeric' });
const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const formatIST = (ms: number) => `${dtFmt.format(new Date(ms))} IST`;
export const formatISTDate = (ms: number) => dFmt.format(new Date(ms));
/** YYYY-MM-DD of the given instant in IST. */
export const istDateString = (ms: number) => isoFmt.format(new Date(ms));

/** Calendar parts of an instant in IST. */
export function istParts(ms: number): { year: number; month: number; day: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** UTC epoch ms of 00:00 IST on the given YYYY-MM-DD. Returns null if invalid. */
export function istDayStart(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
  return istDateString(ms) === date ? ms : null;
}

export const DAY_MS = 86_400_000;
