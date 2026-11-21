import { CouponAssignment, Founder, Order } from '../models/index.js';
import { COUPON_VALID_DAYS } from '../models/CouponAssignment.js';
import { isDuplicateKeyError, notFound, unprocessable } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { logger } from '../utils/logger.js';

/**
 * Customer-bound coupons. Every code lives in EasyOrders; here it is tied to
 * one customer phone. EasyOrders cannot refuse a coupon by phone, so the
 * storefront asks /api/public/coupon-check first, and every order that
 * arrives with a managed code is checked again (couponFlag) as a backstop.
 */

export const COUPON_PROBLEM_MESSAGE = 'هذا الكود به مشكلة ولا يمكن استخدامه.';
export const COUPON_PHONE_MESSAGE = 'اكتب رقم هاتفك أولًا ثم أعد إدخال الكود.';

const CODE_RE = /^[a-z0-9_-]{2,60}$/;
const MOBILE_RE = /^01[0125]\d{8}$/;
export const normalizeCode = (v) => String(v ?? '').trim().toLowerCase();

/** Orders that used each code (cancelled orders do not count). */
async function useCounts(codes, excludeOrderId = null) {
  if (!codes.length) return new Map();
  const match = { couponCode: { $in: codes }, sourceStatus: { $ne: 'canceled' }, deliveryStatus: { $ne: 'cancelled' } };
  if (excludeOrderId) match._id = { $ne: excludeOrderId };
  const rows = await Order.aggregate([{ $match: match }, { $group: { _id: '$couponCode', uses: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.uses]));
}

/**
 * Can `phone` use `code`?  → { managed, allowed, reason }
 * Unmanaged codes (not in our table) are allowed: EasyOrders decides those.
 */
export async function evaluateCoupon(code, phone, { excludeOrderId = null, at = null } = {}) {
  const c = normalizeCode(code);
  const p = normalizePhone(phone);
  const row = await CouponAssignment.findOne({ code: c }).lean();
  if (row) {
    if (!row.phoneNormalized) return { managed: true, allowed: false, reason: 'unassigned' };
    if (row.phoneNormalized !== p) return { managed: true, allowed: false, reason: 'wrong_phone' };
    // Expiry is judged at the moment the order was placed when we know it (flagging), else now.
    if (row.expiresAt && row.expiresAt < (at || new Date())) return { managed: true, allowed: false, reason: 'expired' };
    const uses = (await useCounts([c], excludeOrderId)).get(c) || 0;
    if (uses > 0) return { managed: true, allowed: false, reason: 'already_used' };
    return { managed: true, allowed: true };
  }
  const founder = await Founder.findOne({ personalCode: c }).select('phoneNormalized benefitUntil').lean();
  if (founder) {
    if (founder.phoneNormalized !== p) return { managed: true, allowed: false, reason: 'wrong_phone' };
    if (founder.benefitUntil && founder.benefitUntil < (at || new Date())) return { managed: true, allowed: false, reason: 'expired' };
    return { managed: true, allowed: true };
  }
  return { managed: false, allowed: true };
}

/** Public check used by the storefront. Same answer for every failure reason. */
export async function checkCouponForStorefront({ code, phone }) {
  const c = normalizeCode(code);
  if (!c) return { ok: false, message: COUPON_PROBLEM_MESSAGE };
  const p = normalizePhone(phone);
  const managed = (await CouponAssignment.exists({ code: c })) || (await Founder.exists({ personalCode: c }));
  if (!managed) return { ok: true };
  if (!MOBILE_RE.test(p)) return { ok: false, reason: 'phone_required', message: COUPON_PHONE_MESSAGE };
  const res = await evaluateCoupon(c, p);
  return res.allowed ? { ok: true } : { ok: false, message: COUPON_PROBLEM_MESSAGE };
}

/** Backstop for orders that arrive from EasyOrders. Never throws, never edits the order's money. */
export async function flagCouponMisuse(order) {
  try {
    if (!order?.couponCode) return null;
    const res = await evaluateCoupon(order.couponCode, order.customer?.phoneNormalized, {
      excludeOrderId: order._id,
      at: order.sourceCreatedAt || order.createdAt || null,
    });
    const active = res.managed && !res.allowed;
    const prev = Boolean(order.couponFlag?.active);
    if (!active && !prev) return null;
    const couponFlag = active
      ? { active: true, reason: res.reason, at: order.couponFlag?.at || new Date() }
      : { active: false, reason: order.couponFlag?.reason, at: order.couponFlag?.at };
    await Order.updateOne({ _id: order._id }, { $set: { couponFlag } });
    return couponFlag;
  } catch (err) {
    logger.error('Coupon check failed', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------- pool & assignment

export async function addToPool(codes) {
  const clean = [...new Set(codes.map(normalizeCode).filter(Boolean))];
  const bad = clean.filter((c) => !CODE_RE.test(c));
  if (bad.length) throw unprocessable(`أكواد غير صالحة: ${bad.slice(0, 5).join('، ')}`);
  const existing = new Set((await CouponAssignment.find({ code: { $in: clean } }).select('code').lean()).map((r) => r.code));
  const fresh = clean.filter((c) => !existing.has(c));
  const last = await CouponAssignment.findOne().sort({ seq: -1 }).select('seq').lean();
  let seq = last?.seq || 0;
  if (fresh.length) await CouponAssignment.insertMany(fresh.map((code) => ({ code, seq: ++seq })));
  return { added: fresh.length, skipped: clean.length - fresh.length };
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const expiryFrom = (date) => new Date(date.getTime() + COUPON_VALID_DAYS * DAY_MS);

function assignmentFields(order, via) {
  const assignedAt = new Date();
  return {
    phoneNormalized: order.customer.phoneNormalized,
    customerName: order.customer.name || '',
    order: order._id,
    assignedAt,
    expiresAt: expiryFrom(assignedAt),
    assignedVia: via,
  };
}

/**
 * Give the order's customer the next code in the pool (one code per phone).
 * Returns the assignment, or null when the pool is empty.
 */
export async function ensureCouponForOrder(order, { via = 'auto' } = {}) {
  const phone = order?.customer?.phoneNormalized;
  if (!phone) return null;
  const existing = await CouponAssignment.findOne({ phoneNormalized: phone }).lean();
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await CouponAssignment.findOneAndUpdate(
        { phoneNormalized: null },
        { $set: assignmentFields(order, via) },
        { sort: { seq: 1 }, returnDocument: 'after' },
      ).lean();
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // A concurrent assignment for the same phone won.
      const raced = await CouponAssignment.findOne({ phoneNormalized: phone }).lean();
      if (raced) return raced;
    }
  }
  return null;
}

/** Delivery approval hook. Never throws. */
export async function assignCouponOnDelivery(order) {
  try {
    if (!order || order.isDemo || order.deliveryStatus !== 'delivered') return null;
    return await ensureCouponForOrder(order, { via: 'auto' });
  } catch (err) {
    logger.error('Coupon assignment failed', { error: err.message });
    return null;
  }
}

/** The owner pressed the coupon button on an order: assign now if the customer has no code. */
export async function couponForOrder(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw notFound('الطلب غير موجود');
  if (!order.customer?.phoneNormalized) throw unprocessable('الطلب بدون رقم هاتف');
  const row = await ensureCouponForOrder(order, { via: 'order' });
  if (!row) throw unprocessable('لا توجد أكواد متاحة. أضف أكواد جديدة من تاب الكوبونات.', 'POOL_EMPTY');
  return row;
}

export async function assignManually(id, { phone, name }) {
  const p = normalizePhone(phone);
  if (!MOBILE_RE.test(p)) throw unprocessable('رقم الهاتف غير صالح');
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  if (row.phoneNormalized) throw unprocessable('هذا الكود مخصص لعميل بالفعل');
  if (await CouponAssignment.exists({ phoneNormalized: p })) throw unprocessable('هذا العميل لديه كود بالفعل');
  const assignedAt = new Date();
  Object.assign(row, { phoneNormalized: p, customerName: name || '', assignedAt, expiresAt: expiryFrom(assignedAt), assignedVia: 'manual' });
  await row.save();
  return row.toObject();
}

export async function releaseCoupon(id) {
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  if ((await useCounts([row.code])).get(row.code)) throw unprocessable('لا يمكن إلغاء تخصيص كود استُخدم بالفعل');
  Object.assign(row, { phoneNormalized: null, customerName: '', order: null, assignedAt: null, expiresAt: null, assignedVia: undefined, sentAt: null, sentBy: null });
  await row.save();
  return row.toObject();
}

export async function markCouponSent(id, user) {
  const row = await CouponAssignment.findOneAndUpdate(
    { _id: id, phoneNormalized: { $ne: null } },
    { $set: { sentAt: new Date(), sentBy: user._id } },
    { returnDocument: 'after' },
  ).lean();
  if (!row) throw notFound('الكود غير موجود أو غير مخصص لعميل');
  return row;
}

export async function listCoupons() {
  const rows = await CouponAssignment.find()
    .sort({ seq: 1 })
    .populate('order', 'easyOrdersShortId easyOrdersId')
    .populate('sentBy', 'name')
    .lean();
  const uses = await useCounts(rows.map((r) => r.code));
  const flagged = await Order.find({ 'couponFlag.active': true })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('easyOrdersShortId easyOrdersId couponCode couponFlag customer.name customer.phone sourceStatus')
    .lean();
  const items = rows.map((r) => ({ ...r, uses: uses.get(r.code) || 0 }));
  const assigned = items.filter((r) => r.phoneNormalized);
  return {
    items,
    flagged,
    summary: {
      total: items.length,
      pool: items.length - assigned.length,
      assigned: assigned.length,
      sent: assigned.filter((r) => r.sentAt).length,
      used: items.filter((r) => r.uses > 0).length,
      flagged: flagged.length,
    },
  };
}

/** Attach each order's customer coupon (by phone) to a list of orders. */
export async function attachCoupons(orders) {
  const phones = [...new Set(orders.map((o) => o.customer?.phoneNormalized).filter(Boolean))];
  if (!phones.length) return orders;
  const rows = await CouponAssignment.find({ phoneNormalized: { $in: phones } }).select('code phoneNormalized sentAt').lean();
  const byPhone = new Map(rows.map((r) => [r.phoneNormalized, r]));
  for (const o of orders) {
    const r = byPhone.get(o.customer?.phoneNormalized);
    o.couponAssignment = r ? { _id: r._id, code: r.code, sentAt: r.sentAt } : null;
  }
  return orders;
}
