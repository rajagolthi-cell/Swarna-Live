// CSV helpers. Text cells that a spreadsheet could treat as a formula
// (starting with = + - @ tab or carriage return) get a leading apostrophe.

const FORMULA_START = /^[=+\-@\t\r]/;

export function safeText(v: string | null | undefined): string {
  const s = v ?? '';
  return FORMULA_START.test(s) ? `'${s}` : s;
}

function cell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return String(v);
  const s = safeText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: (string | number | null | undefined)[]): string {
  return values.map(cell).join(',') + '\r\n';
}
