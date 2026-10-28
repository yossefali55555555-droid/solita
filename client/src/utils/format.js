const LOCALE = 'ar-EG-u-nu-latn';

const moneyFormatter = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Amounts arrive from the API as integer piasters. */
export function formatMoney(minor, currency = 'EGP') {
  if (minor === null || minor === undefined) return '—';
  const value = Number(minor) / 100;
  return `${moneyFormatter.format(value)} ${currency === 'EGP' ? 'ج.م' : currency}`;
}

/** Piasters → plain decimal string for form inputs. */
export function minorToInput(minor) {
  if (minor === null || minor === undefined) return '';
  const n = Number(minor);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const dateFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFormatter.format(d);
}

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateFormatter.format(d);
}

export function formatNumber(n) {
  return new Intl.NumberFormat(LOCALE).format(Number(n) || 0);
}

/** Valid money input: up to 9 digits and 2 decimals. */
export function isValidMoneyInput(value) {
  return /^\d{1,9}(\.\d{1,2})?$/.test(String(value).trim());
}

export function toAsciiDigits(value) {
  return String(value ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/** The merchant-facing order number (EasyOrders short_id) when known, else the EasyOrders id. */
export function orderNumber(order) {
  if (!order) return '';
  return order.easyOrdersShortId ? `#${order.easyOrdersShortId}` : order.easyOrdersId || '';
}
