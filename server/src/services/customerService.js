import { NOT_TEST } from '../models/Order.js';
import { Order } from '../models/index.js';
import { notFound } from '../utils/errors.js';
import { escapeRegex } from '../utils/sanitize.js';
import { normalizePhone } from '../utils/phone.js';
import { assertCanSearch, decodeCustomerKey, FULL_VIEWER } from './visibilityService.js';

/**
 * Customers are derived from orders (EasyOrders is the source of customer
 * data), grouped by normalized phone number. Orders without a phone are
 * grouped by name. No separate collection is needed, so every existing order
 * is included automatically.
 */

const NAME_PREFIX = 'name:';

const KEY_EXPR = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ['$customer.phoneNormalized', ''] } }, 0] },
    '$customer.phoneNormalized',
    { $concat: [NAME_PREFIX, { $ifNull: ['$customer.name', ''] }] },
  ],
};

const countIf = (status) => ({ $sum: { $cond: [{ $eq: ['$deliveryStatus', status] }, 1, 0] } });

/**
 * Group stage per viewer (projection layer): the number and the money totals
 * are not even computed for a viewer who may not see them. The group key
 * stays the phone (it is what groups orders) and is encoded on the way out.
 */
function groupStage(viewer) {
  return {
    $group: {
      _id: KEY_EXPR,
      name: { $first: '$customer.name' },
      ...(viewer.phone ? { phone: { $first: '$customer.phone' } } : {}),
      government: { $first: '$customer.government' },
      address: { $first: '$customer.address' },
      ordersCount: { $sum: 1 },
      delivered: countIf('delivered'),
      returned: countIf('returned'),
      failed: countIf('failed'),
      cancelled: countIf('cancelled'),
      ...(viewer.money
        ? {
            totalOrdered: { $sum: '$totalAmount' },
            totalDelivered: { $sum: { $cond: [{ $eq: ['$deliveryStatus', 'delivered'] }, '$totalAmount', 0] } },
          }
        : {}),
      firstOrderAt: { $min: { $ifNull: ['$sourceCreatedAt', '$createdAt'] } },
      lastOrderAt: { $max: { $ifNull: ['$sourceCreatedAt', '$createdAt'] } },
    },
  };
}

function searchMatch(q, viewer) {
  if (!q) return { ...NOT_TEST };
  const rx = new RegExp(escapeRegex(q.trim()), 'i');
  const or = [{ 'customer.name': rx }];
  if (viewer.phone) {
    or.push({ 'customer.phone': rx });
    const phone = normalizePhone(q);
    if (phone.length >= 4) or.push({ 'customer.phoneNormalized': new RegExp(escapeRegex(phone)) });
  }
  return { ...NOT_TEST, $or: or };
}

const SORTS = {
  recent: { lastOrderAt: -1, _id: 1 },
  orders: { ordersCount: -1, lastOrderAt: -1, _id: 1 },
  spent: { totalDelivered: -1, lastOrderAt: -1, _id: 1 },
  returns: { returned: -1, failed: -1, lastOrderAt: -1, _id: 1 },
};

export async function listCustomers({ q, sort = 'recent' } = {}, { skip = 0, limit = 20 } = {}, viewer = FULL_VIEWER) {
  assertCanSearch(viewer, q);
  // Sorting by spend would rank customers by figures the viewer may not see.
  const order = sort === 'spent' && !viewer.money ? 'recent' : sort;
  const [result] = await Order.aggregate([
    { $match: searchMatch(q, viewer) },
    // Newest order first so $first picks the latest name/address.
    { $sort: { sourceCreatedAt: -1, createdAt: -1 } },
    groupStage(viewer),
    { $sort: SORTS[order] || SORTS.recent },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);
  const items = (result?.items || []).map(({ _id, ...rest }) => ({ key: _id, ...rest }));
  return { items, total: result?.total?.[0]?.n || 0 };
}

function matchForKey(key) {
  if (key.startsWith(NAME_PREFIX)) {
    return {
      ...NOT_TEST,
      'customer.name': key.slice(NAME_PREFIX.length),
      $or: [{ 'customer.phoneNormalized': '' }, { 'customer.phoneNormalized': null }, { 'customer.phoneNormalized': { $exists: false } }],
    };
  }
  return { ...NOT_TEST, 'customer.phoneNormalized': key };
}

/**
 * `key` is the opaque key from the list (c_…). A raw key (the phone itself)
 * is only accepted from a viewer who may see numbers; everyone else gets the
 * same "not found" for a wrong, forged or raw key.
 */
export async function getCustomer(key, viewer = FULL_VIEWER) {
  const raw = decodeCustomerKey(key) ?? (viewer.phone ? key : null);
  if (raw === null) throw notFound('العميل غير موجود');
  const match = matchForKey(raw);
  const [summary] = await Order.aggregate([{ $match: match }, { $sort: { sourceCreatedAt: -1, createdAt: -1 } }, groupStage(viewer)]);
  if (!summary) throw notFound('العميل غير موجود');
  const orders = await Order.find(match)
    .sort({ sourceCreatedAt: -1, createdAt: -1 })
    .limit(200)
    .select('easyOrdersId easyOrdersShortId totalAmount currency paymentMethod sourceStatus deliveryStatus assignedTo deliveredAt returnInfo.reason deliveryAttempts.reason deliveryAttempts.note deliveryAttempts.at items.name items.quantity createdAt sourceCreatedAt')
    .populate('assignedTo', 'name')
    .lean();
  const { _id, ...rest } = summary;
  return { customer: { key: _id, ...rest }, orders };
}
