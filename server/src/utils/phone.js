const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Convert Arabic-Indic and Persian digits to ASCII digits. */
export function toAsciiDigits(value) {
  return String(value ?? '').replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : EXTENDED_ARABIC_INDIC.indexOf(d));
  });
}

/**
 * Normalize an Egyptian phone number to the local 11-digit form (01XXXXXXXXX).
 * Accepts +20 / 0020 / 20 prefixes, spaces, dashes and Arabic digits.
 * Returns the cleaned digits (best effort) when the number is not Egyptian
 * mobile-shaped, so customer data is never discarded.
 */
export function normalizePhone(value) {
  let digits = toAsciiDigits(value).replace(/[^\d+]/g, '');
  if (!digits) return '';
  digits = digits.replace(/^\+/, '');
  if (digits.startsWith('0020')) digits = digits.slice(4);
  else if (digits.startsWith('20') && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('1')) digits = `0${digits}`;
  return digits;
}

export const EGYPT_MOBILE_REGEX = /^01[0125]\d{8}$/;

export function isValidEgyptianMobile(value) {
  return EGYPT_MOBILE_REGEX.test(normalizePhone(value));
}
