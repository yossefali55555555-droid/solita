import { Order } from '../models/index.js';
import { notFound } from '../utils/errors.js';
import { escapeRegex } from '../utils/sanitize.js';
import { normalizePhone } from '../utils/phone.js';

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

const GROUP_STAGE = {
  $group: {
    _id: KEY_EXPR,
    name: { $first: '$customer.name' },
    phone: { $first: '$customer.phone' },
    government: { $first: '$customer.government' },
    address: { $first: '$customer.address' },
    ordersCount: { $sum: 1 },
    delivered: countIf('delivered'),
    returned: countIf('returned'),
    failed: countIf('failed'),
    cancelled: countIf('cancelled'),
    totalOrdered: { $sum: '$totalAmount' },
    totalDelivered: { $sum: { $cond: [{ $eq: ['$deliveryStatus', 'delivered'] }, '$totalAmount', 0] } },
    firstOrderAt: { $min: { $ifNull: ['$sourceCreatedAt', '$createdAt'] } },
    lastOrderAt: { $max: { $ifNull: ['$sourceCreatedAt', '$createdAt'] } },
  },
};

function searchMatch(q) {
  if (!q) return {};
  const rx = new RegExp(escapeRegex(q.trim()), 'i');
  const or = [{ 'customer.name': rx }, { 'customer.phone': rx }];
  const phone = normalizePhone(q);
  if (phone.length >= 4) or.push({ 'customer.phoneNormalized': new RegExp(escapeRegex(phone)) });
  return { $or: or };
}

const SORTS = {
  recent: { lastOrderAt: -1, _id: 1 },
  orders: { ordersCount: -1, lastOrderAt: -1, _id: 1 },
  spent: { totalDelivered: -1, lastOrderAt: -1, _id: 1 },
  returns: { returned: -1, failed: -1, lastOrderAt: -1, _id: 1 },
};

export async function listCustomers({ q, sort = 'recent' } = {}, { skip = 0, limit = 20 } = {}) {
  const [result] = await Order.aggregate([
    { $match: searchMatch(q) },
    // Newest order first so $first picks the latest name/address.
    { $sort: { sourceCreatedAt: -1, createdAt: -1 } },
    GROUP_STAGE,
    { $sort: SORTS[sort] || SORTS.recent },
    { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);
  const items = (result?.items || []).map(({ _id, ...rest }) => ({ key: _id, ...rest }));
  return { items, total: result?.total?.[0]?.n || 0 };
}

function matchForKey(key) {
  if (key.startsWith(NAME_PREFIX)) {
    return {
      'customer.name': key.slice(NAME_PREFIX.length),
      $or: [{ 'customer.phoneNormalized': '' }, { 'customer.phoneNormalized': null }, { 'customer.phoneNormalized': { $exists: false } }],
    };
  }
  return { 'customer.phoneNormalized': key };
}

export async function getCustomer(key) {
  const match = matchForKey(key);
  const [summary] = await Order.aggregate([{ $match: match }, { $sort: { sourceCreatedAt: -1, createdAt: -1 } }, GROUP_STAGE]);
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
