import { NOT_TEST, Order } from '../models/Order.js';

/**
 * Delivery record of a customer (by normalized phone) built from Solita's own
 * orders: how many earlier orders were delivered, returned or refused, and a
 * risk level for the order being looked at. Test orders never count.
 *
 *   level: 'new'      no earlier orders
 *          'unknown'  earlier orders exist but none has a final outcome yet
 *          'good'     delivered before, never refused
 *          'moderate' at least one refusal / return, rate still decent
 *          'high'     repeated refusals or a poor rate
 */

const REFUSED = ['returned', 'failed'];

/** Pure: turn counters (excluding the current order) into a verdict. */
export function classifyCustomer({ delivered = 0, refused = 0, cancelled = 0, open = 0 }) {
  const previous = delivered + refused + cancelled + open;
  const decided = delivered + refused;
  const rate = decided > 0 ? delivered / decided : null;
  let level;
  if (previous === 0) level = 'new';
  else if (decided === 0) level = 'unknown';
  else if (refused >= 3 || (refused >= 2 && rate < 0.6) || (decided >= 3 && rate < 0.5)) level = 'high';
  else if (refused >= 1) level = 'moderate';
  else level = 'good';
  return { level, previous, delivered, refused, cancelled, open, decided, rate: rate === null ? null : Math.round(rate * 100) };
}

function bucketOf(deliveryStatus) {
  if (deliveryStatus === 'delivered') return 'delivered';
  if (REFUSED.includes(deliveryStatus)) return 'refused';
  if (deliveryStatus === 'cancelled') return 'cancelled';
  return 'open';
}

/**
 * Adds `customerHistory` to each order (plain objects). One aggregate for all
 * phones on the page; the order itself is subtracted from its own phone.
 */
export async function attachCustomerHistory(orders) {
  const phones = [...new Set(orders.map((o) => o.customer?.phoneNormalized).filter(Boolean))];
  const byPhone = new Map();
  if (phones.length) {
    const rows = await Order.aggregate([
      { $match: { ...NOT_TEST, 'customer.phoneNormalized': { $in: phones } } },
      { $group: { _id: { phone: '$customer.phoneNormalized', status: '$deliveryStatus' }, n: { $sum: 1 } } },
    ]);
    for (const r of rows) {
      const c = byPhone.get(r._id.phone) || { delivered: 0, refused: 0, cancelled: 0, open: 0 };
      c[bucketOf(r._id.status)] += r.n;
      byPhone.set(r._id.phone, c);
    }
  }
  for (const o of orders) {
    const phone = o.customer?.phoneNormalized;
    const all = (phone && byPhone.get(phone)) || { delivered: 0, refused: 0, cancelled: 0, open: 0 };
    const c = { ...all };
    if (!o.isTest && phone) c[bucketOf(o.deliveryStatus)] = Math.max(0, c[bucketOf(o.deliveryStatus)] - 1);
    o.customerHistory = classifyCustomer(c);
  }
  return orders;
}
