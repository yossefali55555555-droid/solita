import { formatMoney, orderNumber } from '../../utils/format.js';

export const STORE_URL = 'https://solita.myeasyorders.com';

const firstName = (order) => (order.customer?.name || '').trim().split(/\s+/)[0] || '';

function tidy(text) {
  return text
    .replace(/(أهلاً|مرحبًا) ،/g, '$1،')
    .replace(/[ \t]{2,}/g, ' ')
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
 * The data-confirmation message for an order under review.
 * Placeholders: {name} (first name), {num}, {items}, {total}, {payment}, {address}.
 */
export function confirmationMessage(order, template) {
  const payment = order.cod?.isCod === false ? 'مدفوع' : 'الدفع عند الاستلام';
  const address = [order.customer?.government, order.customer?.address].filter(Boolean).join('، ');
  return tidy(
    template
      .replaceAll('{name}', firstName(order))
      .replaceAll('{num}', orderNumber(order))
      .replaceAll('{items}', describeOrderItems(order.items))
      .replaceAll('{total}', formatMoney(order.totalAmount, order.currency))
      .replaceAll('{payment}', payment)
      .replaceAll('{address}', address || '—'),
  );
}

/** The customer's personal discount code. Placeholders: {name}, {code}, {store}. */
export function couponMessage(order, code, template) {
  return tidy(
    template
      .replaceAll('{name}', firstName(order))
      .replaceAll('{code}', String(code || '').toUpperCase())
      .replaceAll('{store}', STORE_URL),
  );
}
