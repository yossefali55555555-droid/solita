/**
 * Decimal-safe money handling.
 *
 * All amounts are stored and computed as integer minor units (piasters,
 * 1 EGP = 100 piasters). Conversion from decimal input is done on the string
 * representation, never with floating point multiplication.
 */

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export function toMinor(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid money amount');
    value = value.toFixed(6);
  }
  const str = String(value).trim().replace(/,/g, '');
  const match = DECIMAL_RE.exec(str);
  if (!match) throw new TypeError(`Invalid money amount: ${str}`);
  const [, sign, whole, frac = ''] = match;
  const padded = (frac + '000').slice(0, 3);
  // Round half away from zero on the third decimal.
  let minor = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) throw new TypeError('Money amount out of range');
  return sign ? -minor : minor;
}

/** Safe variant used when normalizing external payloads. */
export function toMinorOrZero(value) {
  try {
    return toMinor(value);
  } catch {
    return 0;
  }
}

export function fromMinor(minor) {
  const n = Number(minor) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function sumMinor(values) {
  return values.reduce((acc, v) => acc + (Number(v) || 0), 0);
}
