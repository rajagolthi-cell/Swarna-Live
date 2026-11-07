import { describe, expect, it } from 'vitest';
import { applicableRatePaise, computeQuote, parseGramsToMg, parsePercentToBp, parseRupeesToPaise, validateQuote } from '../src/shared/calc';
import { istDayStart, istParts } from '../src/shared/time';
import { csvRow, safeText } from '../src/worker/csv';
import { sniffImage } from '../src/worker/image';
import { parseDriveFolderId, parseSpreadsheetUrl } from '../src/worker/google/client';
import { jpeg } from './helpers';

describe('gold and silver calculations', () => {
  it('applies the karat adjustment exactly once', () => {
    // 24K rate ₹7,200.00/g → 22K = 7200 × 22 / 24 = ₹6,600.00
    expect(applicableRatePaise('gold', '22K', 720000)).toBe(660000);
    expect(applicableRatePaise('gold', '24K', 720000)).toBe(720000);
    expect(applicableRatePaise('gold', '18K', 720000)).toBe(540000);
    expect(applicableRatePaise('gold', '14K', 720000)).toBe(420000);
    expect(applicableRatePaise('gold', '20K', 720000)).toBe(600000);
    // silver uses the 999 rate as-is
    expect(applicableRatePaise('silver', '999', 9050)).toBe(9050);
  });

  it('computes net weight, assessed value and offer in paise', () => {
    const r = computeQuote({ metal: 'gold', purity: '22K', grossMg: 10500, deductionMg: 500, baseRatePaise: 720000, pctBp: 6000 });
    expect(r.netMg).toBe(10000);
    expect(r.appliedRatePaise).toBe(660000);
    expect(r.assessedPaise).toBe(6600000); // 10 g × ₹6,600 = ₹66,000
    expect(r.offerPaise).toBe(3960000); // 60% = ₹39,600
  });

  it('rounds half-up to the paisa at each step', () => {
    // 22K of ₹7,123.45 = 712345 × 22 / 24 = 652982.916… → 652983
    expect(applicableRatePaise('gold', '22K', 712345)).toBe(652983);
    const r = computeQuote({ metal: 'gold', purity: '22K', grossMg: 1234, deductionMg: 0, baseRatePaise: 712345, pctBp: 6250 });
    expect(r.assessedPaise).toBe(Math.round(1234 * 652983 / 1000));
    expect(r.offerPaise).toBe(Math.round(r.assessedPaise * 0.625));
  });

  it('silver quote', () => {
    const r = computeQuote({ metal: 'silver', purity: '999', grossMg: 250000, deductionMg: 0, baseRatePaise: 9500, pctBp: 6000 });
    expect(r.assessedPaise).toBe(2375000);
    expect(r.offerPaise).toBe(1425000);
  });

  it('rejects invalid input', () => {
    const base = { metal: 'gold' as const, purity: '22K', grossMg: 1000, deductionMg: 0, baseRatePaise: 700000, pctBp: 6000 };
    expect(validateQuote({ ...base, grossMg: 0 })).toBe('GROSS_INVALID');
    expect(validateQuote({ ...base, deductionMg: 1000 })).toBe('DEDUCTION_INVALID');
    expect(validateQuote({ ...base, deductionMg: -1 })).toBe('DEDUCTION_INVALID');
    expect(validateQuote({ ...base, baseRatePaise: 0 })).toBe('RATE_INVALID');
    expect(validateQuote({ ...base, pctBp: 0 })).toBe('PERCENT_INVALID');
    expect(validateQuote({ ...base, pctBp: 10001 })).toBe('PERCENT_INVALID');
    expect(validateQuote({ ...base, purity: '999' })).toBe('PURITY_INVALID');
    expect(validateQuote({ ...base, metal: 'silver', purity: '22K' })).toBe('PURITY_INVALID');
    expect(validateQuote(base)).toBeNull();
  });

  it('parses user input strictly', () => {
    expect(parseGramsToMg('10.5')).toBe(10500);
    expect(parseGramsToMg('0.001')).toBe(1);
    expect(parseGramsToMg('1.2345')).toBeNull();
    expect(parseGramsToMg('-1')).toBeNull();
    expect(parseGramsToMg('abc')).toBeNull();
    expect(parseRupeesToPaise('7,250.5')).toBe(725050);
    expect(parseRupeesToPaise('7250.555')).toBeNull();
    expect(parsePercentToBp('62.5')).toBe(6250);
    expect(parsePercentToBp('100')).toBe(10000);
  });
});

describe('IST dates', () => {
  it('uses Asia/Kolkata for the business year and day', () => {
    // 31 Dec 2025 20:00 UTC = 1 Jan 2026 01:30 IST
    expect(istParts(Date.UTC(2025, 11, 31, 20, 0)).year).toBe(2026);
    expect(istParts(Date.UTC(2025, 11, 31, 18, 0)).year).toBe(2025);
    expect(istDayStart('2026-01-01')).toBe(Date.UTC(2025, 11, 31, 18, 30));
    expect(istDayStart('2026-02-30')).toBeNull();
  });
});

describe('CSV safety', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(safeText('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeText('+91 98480 12345')).toBe(`'+91 98480 12345`);
    expect(safeText('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(safeText('-2+3')).toBe(`'-2+3`);
    expect(csvRow(['a,b', '=1+1', 5])).toBe(`"a,b",'=1+1,5\r\n`);
  });
});

describe('image validation', () => {
  it('reads real JPEG dimensions and rejects non-images', () => {
    expect(sniffImage(jpeg(1600, 1200))).toEqual({ type: 'image/jpeg', width: 1600, height: 1200 });
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
  });
});

describe('Google link parsing (no URL is ever fetched)', () => {
  it('accepts only Google Drive folder and Sheets links', () => {
    expect(parseDriveFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(parseDriveFolderId('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(parseDriveFolderId('https://evil.example/drive/folders/1AbCdEfGhIjKlMnOp')).toBeNull();
    expect(parseDriveFolderId('http://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toBeNull();
    expect(parseSpreadsheetUrl('https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit#gid=42'))
      .toEqual({ id: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ', gid: 42 });
    expect(parseSpreadsheetUrl('https://docs.google.com.evil.example/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ')).toBeNull();
  });
});
