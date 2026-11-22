import { formatMoney, orderNumber } from '../../utils/format.js';

export const STORE_URL = 'https://solita.myeasyorders.com';

const firstName = (order) => (order.customer?.name || '').trim().split(/\s+/)[0] || '';

function tidy(text) {
  return text
    .replace(/(أهلاً|مرحبًا) ،/g, '$1،')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Samba (مقاس 42) × 2" lines, one per item. */
export function describeOrderItems(items = []) {
  return items
    .filter((i) => i.quantity > 0)
    .map((i) => {
      const size = (i.options || []).find((o) => /size|مقاس/i.test(o.name))?.value || '';
      const extra = (i.options || []).filter((o) => !/size|مقاس/i.test(o.name)).map((o) => o.value);
      const detail = [size ? `مقاس ${size}` : '', ...extra].filter(Boolean).join('، ');
      return `- ${i.name}${detail ? ` (${detail})` : ''}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`;
    })
    .join('\n');
}

/**
 * How the customer pays, from EasyOrders' `payment_method`. Keys that exist in EasyOrders
 * (read from its dashboard): cod, transfer_receipt (transfer + receipt image), paymob (Visa/Mastercard),
 * paymob wallets, vodafone_cash, and the mixed gateways kashier, fawaterk, xpay, easykash, fabmisr, upay, taager, paypal, ziina.
 */
export function paymentKind(order) {
  const v = String(order.paymentMethod || '').toLowerCase();
  if (!v || v === 'cod' || v.includes('cash_on') || order.cod?.isCod) return 'cod';
  if (v.includes('transfer') || v.includes('instapay')) return 'transfer';
  if (v.includes('wallet') || v.includes('vodafone') || v.includes('etisalat')) return 'wallet';
  if (/visa|master|card|paymob|ziina/.test(v)) return 'card';
  return 'online';
}

/** The payment sentence of the confirmation message; never says "cash on delivery" for an online order. */
export function paymentLine(order) {
  const paid = order.paymentStatus === 'paid';
  switch (paymentKind(order)) {
    case 'cod':
      return 'الدفع عند الاستلام.';
    case 'transfer':
      return paid
        ? 'تم الدفع بالتحويل (إنستا باي أو المحفظة)، ومفيش مبلغ هتدفعه للمندوب.'
        : 'الدفع بالتحويل (إنستا باي أو المحفظة)، وبانتظار تأكيد وصول المبلغ.';
    case 'wallet':
      return paid ? 'تم الدفع بالمحفظة، ومفيش مبلغ هتدفعه للمندوب.' : 'الدفع بالمحفظة، وبانتظار تأكيد العملية.';
    case 'card':
      return paid ? 'تم الدفع بالفيزا، ومفيش مبلغ هتدفعه للمندوب.' : 'الدفع بالفيزا، وبانتظار تأكيد العملية.';
    default:
      return paid ? 'تم الدفع أونلاين، ومفيش مبلغ هتدفعه للمندوب.' : 'الدفع أونلاين، وبانتظار تأكيد العملية.';
  }
}

/**
 * The data-confirmation message for an order under review.
 * Placeholders: {name} (first name), {num}, {items}, {total}, {payment}, {address}.
 */
export function confirmationMessage(order, template) {
  const address = [order.customer?.government, order.customer?.address].filter(Boolean).join('، ');
  return tidy(
    template
      .replaceAll('{name}', firstName(order))
      .replaceAll('{num}', orderNumber(order))
      .replaceAll('{items}', describeOrderItems(order.items))
      .replaceAll('{total}', formatMoney(order.totalAmount, order.currency))
      .replaceAll('{payment}', paymentLine(order))
      .replaceAll('{address}', address || '—'),
  );
}

/** dd/mm/yyyy on the Cairo calendar. */
export function cairoDate(value) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value));
  return parts;
}

/**
 * The customer's personal discount code.
 * Placeholders: {name}, {code}, {store}, {start}, {end} (the 365 days, dd/mm/yyyy).
 */
export function couponMessage(order, coupon, template) {
  return tidy(
    template
      .replaceAll('{name}', firstName(order))
      .replaceAll('{code}', String(coupon.code || '').toUpperCase())
      .replaceAll('{store}', STORE_URL)
      .replaceAll('{start}', coupon.sentAt ? cairoDate(coupon.sentAt) : '')
      .replaceAll('{end}', coupon.expiresAt ? cairoDate(coupon.expiresAt) : ''),
  );
}
