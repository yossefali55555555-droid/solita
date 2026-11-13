import { Order, StorefrontCart, StorefrontDailyStat, Visitor } from '../models/index.js';
import { CART_EXPIRE_AFTER_DAYS, CART_PHONE_MATCH_DAYS } from '../models/StorefrontCart.js';
import { VISITOR_LAST_PAGES } from '../models/Visitor.js';
import { storefrontEventSchema } from '../validators/storefront.js';
import { isDuplicateKeyError, notFound, unprocessable } from '../utils/errors.js';
import { toMinor } from '../utils/money.js';
import { logger } from '../utils/logger.js';

/**
 * Storefront integration: anonymous visitors, abandoned carts and the
 * visitor-behaviour summary. Data arrives from the site through
 * POST /api/public/events (see validators/storefront.js for the shapes).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = ['open', 'contacted'];

// ---------- Cairo calendar days ----------
const cairoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function cairoOffsetMs(date) {
  const p = Object.fromEntries(cairoParts.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 Cairo time on the Cairo day that contains `date`, minus `daysBack` days. */
export function cairoDayStart(date = new Date(), daysBack = 0) {
  const offset = cairoOffsetMs(date);
  const local = new Date(date.getTime() + offset);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBack);
  // Re-check the offset at the resulting instant (DST changes).
  const guess = new Date(midnightLocal - offset);
  return new Date(midnightLocal - cairoOffsetMs(guess));
}

// ---------- Cart helpers ----------
const itemKey = (i) => `${i.slug}|${i.size || ''}`;

function toStoredItem(i) {
  return {
    slug: i.slug,
    sku: i.sku || '',
    name: i.name || '',
    size: i.size || '',
    qty: i.qty,
    price: toMinor(i.price),
  };
}

function totals(items) {
  return {
    itemsCount: items.reduce((n, i) => n + i.qty, 0),
    value: items.reduce((n, i) => n + i.qty * i.price, 0),
  };
}

function mergeItems(list) {
  const map = new Map();
  for (const item of list) {
    const k = itemKey(item);
    const prev = map.get(k);
    if (prev) prev.qty = Math.min(99, prev.qty + item.qty);
    else map.set(k, { ...item });
  }
  return [...map.values()];
}

/** Find an EasyOrders order already stored in the system for an order_placed event. */
async function findOrderRef({ orderId, shortId }) {
  const or = [];
  if (orderId) or.push({ easyOrdersId: orderId });
  if (shortId) or.push({ easyOrdersShortId: shortId });
  if (!or.length) return null;
  return Order.findOne({ $or: or }, { _id: 1 }).lean();
}

/**
 * Apply one validated batch. Returns { accepted, rejected }.
 *
 * Events are applied in order to the visitor's active cart: cart_snapshot
 * replaces the items, cart_add / cart_remove change them, checkout_contact
 * stores the name and phone typed at checkout, and order_placed marks the
 * cart converted (later events in the same batch start a new cart).
 */
export async function ingestEvents({ visitorId, newVisit = false, events }, { now = new Date() } = {}) {
  const valid = [];
  let rejected = 0;
  for (const raw of events) {
    const parsed = storefrontEventSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else rejected += 1;
  }

  await updateVisitor(visitorId, newVisit, valid, now);
  await updateDailyStats(valid, now);
  await applyCartEvents(visitorId, valid, now);

  return { accepted: valid.length, rejected };
}

async function updateVisitor(visitorId, newVisit, events, now) {
  const pages = events
    .filter((e) => e.type === 'page_view')
    .map((e) => ({ path: e.path, title: e.title || '', at: now }));
  const update = {
    $setOnInsert: { firstSeen: now },
    $set: { lastSeen: now },
    $inc: { visits: newVisit ? 1 : 0, pages: pages.length },
  };
  if (pages.length) update.$push = { lastPages: { $each: pages, $slice: -VISITOR_LAST_PAGES } };
  try {
    await Visitor.updateOne({ visitorId }, update, { upsert: true });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    await Visitor.updateOne({ visitorId }, update); // concurrent first batch
  }
}

async function updateDailyStats(events, now) {
  const day = cairoDayStart(now);
  const counters = new Map();
  const bump = (slug, name, field) => {
    const c = counters.get(slug) || { name: '', views: 0, adds: 0 };
    if (name) c.name = name;
    c[field] += 1;
    counters.set(slug, c);
  };
  for (const e of events) {
    if (e.type === 'product_view') bump(e.product.slug, e.product.name, 'views');
    if (e.type === 'cart_add') bump(e.item.slug, e.item.name, 'adds');
  }
  if (!counters.size) return;
  await StorefrontDailyStat.bulkWrite(
    [...counters].map(([slug, c]) => ({
      updateOne: {
        filter: { day, slug },
        update: { $inc: { views: c.views, adds: c.adds }, ...(c.name ? { $set: { name: c.name } } : {}) },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function applyCartEvents(visitorId, events, now) {
  const cartEvents = events.filter((e) =>
    ['cart_add', 'cart_remove', 'cart_snapshot', 'checkout_contact', 'order_placed'].includes(e.type),
  );
  const existing = await StorefrontCart.findOne({ visitorId, active: true }).lean();
  if (!cartEvents.length) {
    if (existing) await StorefrontCart.updateOne({ _id: existing._id }, { $set: { lastSeenAt: now } });
    return;
  }

  let cart = existing ? { ...existing, items: existing.items.map((i) => ({ ...i })) } : null;
  let dirty = false;
  const fresh = () => ({ visitorId, active: true, status: 'open', items: [], customer: {}, lastActivityAt: now, lastSeenAt: now });

  const flush = async (final) => {
    if (!cart || !dirty) return;
    const { itemsCount, value } = totals(cart.items);
    const set = {
      items: cart.items,
      itemsCount,
      value,
      customer: cart.customer || {},
      lastActivityAt: now,
      lastSeenAt: now,
      active: final.active,
      status: final.status,
      ...(final.converted || {}),
    };
    if (cart._id) {
      await StorefrontCart.updateOne({ _id: cart._id }, { $set: set });
    } else if (itemsCount > 0 || set.customer.phoneNormalized || final.converted) {
      try {
        await StorefrontCart.create({ visitorId, ...set });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // A concurrent batch created the active cart first: apply on top of it.
        const other = await StorefrontCart.findOne({ visitorId, active: true }).lean();
        if (other) await StorefrontCart.updateOne({ _id: other._id }, { $set: set });
      }
    }
  };

  for (const e of cartEvents) {
    if (e.type === 'order_placed') {
      const order = await findOrderRef(e);
      cart ||= fresh();
      if (e.phone && !cart.customer?.phoneNormalized) cart.customer = { ...(cart.customer || {}), phone: e.phone, phoneNormalized: e.phone };
      dirty = true;
      await flush({
        active: false,
        status: 'converted',
        converted: {
          convertedAt: now,
          convertedVia: 'order_placed',
          convertedOrderId: e.orderId || null,
          convertedShortId: e.shortId || null,
          convertedOrder: order?._id || null,
        },
      });
      cart = null;
      dirty = false;
      continue;
    }
    cart ||= fresh();
    dirty = true;
    if (e.type === 'cart_snapshot') {
      cart.items = mergeItems(e.items.map(toStoredItem));
    } else if (e.type === 'cart_add') {
      cart.items = mergeItems([...cart.items, toStoredItem(e.item)]);
    } else if (e.type === 'cart_remove') {
      const k = itemKey({ slug: e.item.slug, size: e.item.size || '' });
      cart.items = cart.items
        .map((i) => (itemKey(i) === k ? { ...i, qty: e.item.qty ? i.qty - e.item.qty : 0 } : i))
        .filter((i) => i.qty > 0);
    } else if (e.type === 'checkout_contact') {
      cart.customer = {
        name: e.name ?? cart.customer?.name ?? '',
        phone: e.phone,
        phoneNormalized: e.phone,
      };
    }
  }
  if (cart) await flush({ active: true, status: cart.status && ACTIVE.includes(cart.status) ? cart.status : 'open' });
}

// ---------- Conversion from EasyOrders orders ----------

/**
 * Called after an EasyOrders order is stored (webhook, poll or manual
 * import). Links carts that reported this order through order_placed, and
 * (for newly created orders only, `phoneMatch`) converts active carts whose
 * checkout phone equals the order's phone.
 * Never throws: storefront data must not affect the order flow.
 */
export async function convertCartsForOrder(order, { now = new Date(), phoneMatch = true } = {}) {
  try {
    if (!order) return { linked: 0, converted: 0 };
    let linked = 0;
    const refs = [];
    if (order.easyOrdersId) refs.push({ convertedOrderId: order.easyOrdersId });
    if (order.easyOrdersShortId) refs.push({ convertedShortId: order.easyOrdersShortId });
    if (refs.length) {
      const res = await StorefrontCart.updateMany(
        { status: 'converted', convertedOrder: null, $or: refs },
        { $set: { convertedOrder: order._id } },
      );
      linked = res.modifiedCount;
    }

    let converted = 0;
    const phone = order.customer?.phoneNormalized;
    if (phoneMatch && phone) {
      const res = await StorefrontCart.updateMany(
        {
          active: true,
          'customer.phoneNormalized': phone,
          lastActivityAt: { $gte: new Date(now.getTime() - CART_PHONE_MATCH_DAYS * DAY_MS) },
        },
        {
          $set: {
            active: false,
            status: 'converted',
            convertedAt: now,
            convertedVia: 'phone_match',
            convertedOrderId: order.easyOrdersId || null,
            convertedShortId: order.easyOrdersShortId || null,
            convertedOrder: order._id,
          },
        },
      );
      converted = res.modifiedCount;
    }
    return { linked, converted };
  } catch (err) {
    logger.error('Storefront cart conversion failed', { error: err.message });
    return { linked: 0, converted: 0, error: true };
  }
}

/** Active carts without activity for CART_EXPIRE_AFTER_DAYS become "expired". */
export async function expireStaleCarts({ now = new Date() } = {}) {
  const res = await StorefrontCart.updateMany(
    { active: true, lastActivityAt: { $lt: new Date(now.getTime() - CART_EXPIRE_AFTER_DAYS * DAY_MS) } },
    { $set: { active: false, status: 'expired' } },
  );
  return { expired: res.modifiedCount };
}

// ---------- Admin ----------
const RANGE_DAYS = { today: 0, '3d': 2, '7d': 6, '30d': 29 };

export async function listCarts(query, { skip, limit }, { now = new Date() } = {}) {
  const filter = { itemsCount: { $gt: 0 } };
  const status = query.status || 'active';
  if (status === 'active') filter.status = { $in: ACTIVE };
  else if (status !== 'all') filter.status = status;
  if (query.range && query.range !== 'all') {
    filter.lastActivityAt = { $gte: cairoDayStart(now, RANGE_DAYS[query.range]) };
  }
  if (query.hasPhone === 'true') filter['customer.phoneNormalized'] = { $nin: ['', null] };
  if (query.hasPhone === 'false') filter['customer.phoneNormalized'] = { $in: ['', null] };
  if (query.notContacted === 'true') filter.contactedAt = null;

  const [items, total] = await Promise.all([
    StorefrontCart.find(filter)
      .sort({ lastActivityAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('contactedBy', 'name')
      .populate('convertedOrder', 'easyOrdersId easyOrdersShortId')
      .lean(),
    StorefrontCart.countDocuments(filter),
  ]);
  return { items, total };
}

export async function markCartContacted(user, id) {
  const cart = await StorefrontCart.findOneAndUpdate(
    { _id: id, status: { $in: ACTIVE } },
    { $set: { status: 'contacted', contactedAt: new Date(), contactedBy: user._id }, $inc: { contactCount: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (cart) return cart;
  if (!(await StorefrontCart.exists({ _id: id }))) throw notFound('السلة غير موجودة');
  throw unprocessable('لا يمكن تعديل سلة تم تحويلها لطلب أو انتهت');
}

export async function dismissCart(user, id) {
  const cart = await StorefrontCart.findOneAndUpdate(
    { _id: id, status: { $in: ACTIVE } },
    { $set: { status: 'expired', active: false, dismissedAt: new Date(), dismissedBy: user._id } },
    { returnDocument: 'after' },
  ).lean();
  if (cart) return cart;
  if (!(await StorefrontCart.exists({ _id: id }))) throw notFound('السلة غير موجودة');
  throw unprocessable('لا يمكن تعديل سلة تم تحويلها لطلب أو انتهت');
}

/** Visitors today / 7 days, top viewed products, most added-to-cart without purchase (7 days). */
export async function behaviourSummary({ now = new Date() } = {}) {
  const today = cairoDayStart(now);
  const weekStart = cairoDayStart(now, 6);
  const [visitorsToday, visitors7d, topViewed, carts7d, notBought] = await Promise.all([
    Visitor.countDocuments({ lastSeen: { $gte: today } }),
    Visitor.countDocuments({ lastSeen: { $gte: weekStart } }),
    StorefrontDailyStat.aggregate([
      { $match: { day: { $gte: weekStart } } },
      { $group: { _id: '$slug', name: { $last: '$name' }, views: { $sum: '$views' }, adds: { $sum: '$adds' } } },
      { $match: { views: { $gt: 0 } } },
      { $sort: { views: -1, _id: 1 } },
      { $limit: 5 },
    ]),
    StorefrontCart.aggregate([
      { $match: { lastActivityAt: { $gte: weekStart }, itemsCount: { $gt: 0 } } },
      { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$value' } } },
    ]),
    StorefrontCart.aggregate([
      { $match: { lastActivityAt: { $gte: weekStart }, status: { $ne: 'converted' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.slug',
          name: { $last: '$items.name' },
          carts: { $sum: 1 },
          qty: { $sum: '$items.qty' },
          value: { $sum: { $multiply: ['$items.qty', '$items.price'] } },
        },
      },
      { $sort: { carts: -1, qty: -1, _id: 1 } },
      { $limit: 5 },
    ]),
  ]);
  const byStatus = Object.fromEntries(carts7d.map((c) => [c._id, { count: c.count, value: c.value }]));
  return {
    visitorsToday,
    visitors7d,
    carts7d: {
      open: byStatus.open?.count || 0,
      contacted: byStatus.contacted?.count || 0,
      converted: byStatus.converted?.count || 0,
      expired: byStatus.expired?.count || 0,
      abandonedValue: (byStatus.open?.value || 0) + (byStatus.contacted?.value || 0),
    },
    topViewed: topViewed.map((p) => ({ slug: p._id, name: p.name, views: p.views, adds: p.adds })),
    addedNotBought: notBought.map((p) => ({ slug: p._id, name: p.name, carts: p.carts, qty: p.qty, value: p.value })),
  };
}
