import { CouponAssignment, CouponAttempt, Founder, Order, StorefrontCart, User } from '../models/index.js';
import { COUPON_VALID_DAYS } from '../models/CouponAssignment.js';
import { isDuplicateKeyError, notFound, unprocessable } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { logger } from '../utils/logger.js';
import { notify } from './notificationService.js';

/**
 * Customer-bound coupons. Every code lives in EasyOrders; here it is tied to
 * one customer phone and valid for 365 days from the day it reaches the
 * customer. It can be used on any number of orders inside that window.
 * EasyOrders cannot refuse a coupon by phone, so the storefront asks
 * /api/public/coupon-check first, and every order that arrives with a bound
 * code is checked again (couponFlag) as a backstop.
 */

export const COUPON_PROBLEM_MESSAGE = 'هذا الكود به مشكلة ولا يمكن استخدامه.';
export const COUPON_PHONE_MESSAGE = 'اكتب رقم هاتفك أولًا ثم أعد إدخال الكود.';

const CODE_RE = /^[a-z0-9_-]{2,60}$/;
const MOBILE_RE = /^01[0125]\d{8}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const normalizeCode = (v) => String(v ?? '').trim().toLowerCase();
export const expiryFrom = (date) => new Date(date.getTime() + COUPON_VALID_DAYS * DAY_MS);

// ---------------------------------------------------------------- history (undo)

const TRACKED = ['phoneNormalized', 'customerName', 'order', 'assignedAt', 'expiresAt', 'assignedVia', 'sentAt', 'sentBy', 'bound', 'pendingEo'];
const HISTORY_LIMIT = 30;
const EMPTY_BEFORE = Object.freeze({ phoneNormalized: null, customerName: '', order: null, assignedAt: null, expiresAt: null, assignedVia: null, sentAt: null, sentBy: null });

function snapshot(row) {
  const out = {};
  for (const k of TRACKED) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

/** Push the values a change is about to replace (call before changing the row, then save). */
function remember(row, action, user) {
  row.history.push({ at: new Date(), by: user?._id || null, action, before: snapshot(row) });
  if (row.history.length > HISTORY_LIMIT) row.history.splice(0, row.history.length - HISTORY_LIMIT);
}

export const ACTION_LABELS = {
  assign: 'تخصيص الكود',
  release: 'إلغاء التخصيص',
  sent: 'إرسال الكود',
  dates: 'تعديل التواريخ',
  settings: 'تعديل الإعدادات',
};

/** Undo the most recent change of a code: restores exactly what it replaced. */
export async function undoLastChange(id) {
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  const last = row.history[row.history.length - 1];
  if (!last) throw unprocessable('مفيش تغيير يتراجع عنه');
  const before = last.before || {};
  if (before.phoneNormalized && before.phoneNormalized !== row.phoneNormalized) {
    const clash = await CouponAssignment.exists({ _id: { $ne: row._id }, phoneNormalized: before.phoneNormalized });
    if (clash) throw unprocessable('العميل ده خد كود تاني في الفترة دي، مينفعش نرجّع الكود ده له');
  }
  for (const k of TRACKED) row[k] = before[k] === undefined ? null : before[k];
  if (!row.customerName) row.customerName = '';
  row.markModified('pendingEo');
  row.history.pop();
  await row.save();
  return row.toObject();
}

/**
 * Can `phone` use `code`?  → { managed, allowed, reason }
 * Only bound coupons and founder codes are managed here; everything else is
 * left to EasyOrders.
 */
export async function evaluateCoupon(code, phone, { at = null } = {}) {
  const c = normalizeCode(code);
  const p = normalizePhone(phone);
  const when = at || new Date();
  const row = await CouponAssignment.findOne({ code: c, bound: { $ne: false } }).lean();
  if (row) {
    if (!row.phoneNormalized) return { managed: true, allowed: false, reason: 'unassigned', row };
    if (row.phoneNormalized !== p) return { managed: true, allowed: false, reason: 'wrong_phone', row };
    if (row.expiresAt && row.expiresAt < when) return { managed: true, allowed: false, reason: 'expired', row };
    return { managed: true, allowed: true, row };
  }
  const founder = await Founder.findOne({ personalCode: c }).select('phoneNormalized name benefitUntil').lean();
  if (founder) {
    const row = { phoneNormalized: founder.phoneNormalized, customerName: founder.name };
    if (founder.phoneNormalized !== p) return { managed: true, allowed: false, reason: 'wrong_phone', row };
    if (founder.benefitUntil && founder.benefitUntil < when) return { managed: true, allowed: false, reason: 'expired', row };
    return { managed: true, allowed: true, row };
  }
  return { managed: false, allowed: true };
}

async function notifyAdmins(attempt) {
  try {
    const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
    const who = attempt.phoneNormalized || attempt.phoneTyped || 'بدون رقم';
    const message = `محاولة استخدام كوبون ${String(attempt.code).toUpperCase()} من رقم ${who}`;
    await Promise.all(admins.map((a) => notify(a._id, 'coupon_attempt', message)));
  } catch (err) {
    logger.warn('Coupon attempt notification failed', { error: err.message });
  }
}

async function logAttempt({ code, reason, stage, phone, name, visitorId, row }) {
  try {
    const phoneNormalized = normalizePhone(phone);
    const since = new Date(Date.now() - DAY_MS);
    const repeat = await CouponAttempt.exists({
      code,
      createdAt: { $gte: since },
      $or: [{ phoneNormalized: phoneNormalized || '__none__' }, ...(visitorId ? [{ visitorId }] : [])],
    });
    const attempt = await CouponAttempt.create({
      code,
      reason,
      stage: stage === 'submit' ? 'submit' : 'apply',
      phoneTyped: String(phone ?? '').slice(0, 40),
      phoneNormalized,
      name: String(name ?? '').slice(0, 200),
      visitorId: /^[A-Za-z0-9-]{16,64}$/.test(visitorId || '') ? visitorId : '',
      ownerPhone: row?.phoneNormalized || '',
      ownerName: row?.customerName || '',
    });
    // One notification per person per code per day.
    if (!repeat) await notifyAdmins(attempt);
  } catch (err) {
    logger.warn('Coupon attempt log failed', { error: err.message });
  }
}

/** Public check used by the storefront. Same answer for every failure reason. */
export async function checkCouponForStorefront({ code, phone, name, visitorId, stage }) {
  const c = normalizeCode(code);
  if (!c) return { ok: false, message: COUPON_PROBLEM_MESSAGE };
  const typed = String(phone ?? '').trim();
  const p = normalizePhone(typed);
  const managed = (await CouponAssignment.exists({ code: c, bound: { $ne: false } })) || (await Founder.exists({ personalCode: c }));
  if (!managed) return { ok: true };
  if (!typed) return { ok: false, reason: 'phone_required', message: COUPON_PHONE_MESSAGE };
  if (!MOBILE_RE.test(p)) {
    await logAttempt({ code: c, reason: 'bad_phone', stage, phone: typed, name, visitorId });
    return { ok: false, message: COUPON_PROBLEM_MESSAGE };
  }
  const res = await evaluateCoupon(c, p);
  if (res.allowed) return { ok: true };
  await logAttempt({ code: c, reason: res.reason, stage, phone: typed, name, visitorId, row: res.row });
  return { ok: false, message: COUPON_PROBLEM_MESSAGE };
}

/** Backstop for orders that arrive from EasyOrders. Never throws, never edits the order's money. */
export async function flagCouponMisuse(order) {
  try {
    if (!order?.couponCode) return null;
    const res = await evaluateCoupon(order.couponCode, order.customer?.phoneNormalized, {
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

async function nextSeq() {
  const last = await CouponAssignment.findOne().sort({ seq: -1 }).select('seq').lean();
  return last?.seq || 0;
}

export async function addToPool(codes) {
  const clean = [...new Set(codes.map(normalizeCode).filter(Boolean))];
  const bad = clean.filter((c) => !CODE_RE.test(c));
  if (bad.length) throw unprocessable(`أكواد غير صالحة: ${bad.slice(0, 5).join('، ')}`);
  const existing = new Set((await CouponAssignment.find({ code: { $in: clean } }).select('code').lean()).map((r) => r.code));
  const fresh = clean.filter((c) => !existing.has(c));
  let seq = await nextSeq();
  if (fresh.length) await CouponAssignment.insertMany(fresh.map((code) => ({ code, seq: ++seq })));
  return { added: fresh.length, skipped: clean.length - fresh.length };
}

function assignmentFields(order, via) {
  const assignedAt = new Date();
  return {
    phoneNormalized: order.customer.phoneNormalized,
    customerName: order.customer.name || '',
    order: order._id,
    assignedAt,
    // Provisional: the real 365 days start the day the code is sent to the customer.
    expiresAt: expiryFrom(assignedAt),
    assignedVia: via,
  };
}

/**
 * Give the order's customer the next bound code in the pool (one code per phone).
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
        { phoneNormalized: null, bound: { $ne: false } },
        {
          $set: assignmentFields(order, via),
          $push: { history: { $each: [{ at: new Date(), by: null, action: 'assign', before: EMPTY_BEFORE }], $slice: -HISTORY_LIMIT } },
        },
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
  if (!row) throw unprocessable('لا توجد أكواد متاحة. استورد أو أضف أكواد جديدة من تاب الكوبونات.', 'POOL_EMPTY');
  return row;
}

export async function assignManually(id, { phone, name }, user = null) {
  const p = normalizePhone(phone);
  if (!MOBILE_RE.test(p)) throw unprocessable('رقم الهاتف غير صالح');
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  if (row.phoneNormalized) throw unprocessable('هذا الكود مخصص لعميل بالفعل');
  if (await CouponAssignment.exists({ phoneNormalized: p })) throw unprocessable('هذا العميل لديه كود بالفعل');
  const assignedAt = new Date();
  remember(row, 'assign', user);
  Object.assign(row, { phoneNormalized: p, customerName: name || '', assignedAt, expiresAt: expiryFrom(assignedAt), assignedVia: 'manual' });
  await row.save();
  return row.toObject();
}

export async function releaseCoupon(id, user = null) {
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  if (!row.phoneNormalized) throw unprocessable('الكود مش مخصص لحد');
  remember(row, 'release', user);
  Object.assign(row, { phoneNormalized: null, customerName: '', order: null, assignedAt: null, expiresAt: null, assignedVia: undefined, sentAt: null, sentBy: null });
  await row.save();
  return row.toObject();
}

/**
 * The code reached the customer. The first send starts the 365 days
 * (sentAt .. expiresAt); sending again keeps the same dates.
 */
export async function markCouponSent(id, user) {
  const row = await CouponAssignment.findOne({ _id: id, phoneNormalized: { $ne: null } });
  if (!row) throw notFound('الكود غير موجود أو غير مخصص لعميل');
  if (!row.sentAt) {
    const now = new Date();
    remember(row, 'sent', user);
    row.sentAt = now;
    row.sentBy = user._id;
    row.expiresAt = expiryFrom(now);
    // Also ask EasyOrders to expire the code on the same day (applied by the next sync).
    if (row.eo) row.pendingEo = { ...(row.pendingEo || {}), expires_at: row.expiresAt.toISOString() };
    row.markModified('pendingEo');
    await row.save();
  }
  return row.toObject();
}

/**
 * The owner sets the dates by hand. `sentAt` = the day the customer got the code (null = not sent yet),
 * `expiresAt` = the last valid day. Changing only the start moves the end to start + 365 days.
 */
export async function editDates(id, { sentAt, expiresAt }, user = null) {
  const row = await CouponAssignment.findOne({ _id: id, phoneNormalized: { $ne: null } });
  if (!row) throw notFound('الكود غير موجود أو غير مخصص لعميل');
  remember(row, 'dates', user);
  if (sentAt !== undefined) {
    row.sentAt = sentAt;
    row.sentBy = sentAt ? user?._id || row.sentBy : null;
    if (expiresAt === undefined) row.expiresAt = expiryFrom(sentAt || row.assignedAt || new Date());
  }
  if (expiresAt !== undefined) row.expiresAt = expiresAt;
  if (row.sentAt && row.expiresAt <= row.sentAt) throw unprocessable('تاريخ النهاية لازم يكون بعد تاريخ البداية');
  if (row.eo && row.expiresAt) {
    row.pendingEo = { ...(row.pendingEo || {}), expires_at: row.expiresAt.toISOString() };
    row.markModified('pendingEo');
  }
  await row.save();
  return row.toObject();
}

// ---------------------------------------------------------------- EasyOrders mirror

const EDITABLE = { value: 'value', usageLimit: 'usage_limit', isActive: 'is_active' };

function sameValue(a, b) {
  if (a instanceof Date || b instanceof Date || (typeof a === 'string' && typeof b === 'string' && /T.*Z$/.test(a))) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return a === b;
}

/** Drop the pending edits that EasyOrders already reflects. */
function prunePending(pending, eo) {
  if (!pending) return null;
  const left = Object.fromEntries(Object.entries(pending).filter(([k, v]) => !sameValue(eo?.[k], v)));
  return Object.keys(left).length ? left : null;
}

/**
 * Import / refresh coupons from the full EasyOrders coupon objects.
 * Keeps our own fields (customer, dates, sent). New codes starting with st30- are
 * customer-bound by default; others are left to EasyOrders until switched on.
 */
export async function importFromEasyOrders(coupons) {
  let created = 0;
  let updated = 0;
  let seq = await nextSeq();
  const now = new Date();
  for (const eo of coupons) {
    const code = normalizeCode(eo?.code);
    if (!CODE_RE.test(code)) continue;
    const row = await CouponAssignment.findOne({ code });
    if (row) {
      row.eo = eo;
      row.eoSyncedAt = now;
      row.pendingEo = prunePending(row.pendingEo, eo);
      row.markModified('eo');
      row.markModified('pendingEo');
      await row.save();
      updated += 1;
    } else {
      await CouponAssignment.create({ code, seq: ++seq, bound: code.startsWith('st30-'), eo, eoSyncedAt: now });
      created += 1;
    }
  }
  return { created, updated };
}

/** Owner edits from the dashboard: `bound` applies here, the rest waits for the sync. */
export async function updateCouponSettings(id, patch, user = null) {
  const row = await CouponAssignment.findById(id);
  if (!row) throw notFound('الكود غير موجود');
  remember(row, 'settings', user);
  if (patch.bound !== undefined) {
    if (patch.bound === false && row.phoneNormalized) throw unprocessable('الكود مخصص لعميل، ألغِ التخصيص قبل ما تفصله عن العملاء');
    row.bound = patch.bound;
  }
  const wanted = {};
  for (const [k, eoKey] of Object.entries(EDITABLE)) if (patch[k] !== undefined) wanted[eoKey] = patch[k];
  if (Object.keys(wanted).length) {
    if (!row.eo) throw unprocessable('اعمل مزامنة مع EasyOrders الأول عشان تقدر تعدّل إعداداته');
    const pending = { ...(row.pendingEo || {}), ...wanted };
    row.pendingEo = prunePending(pending, row.eo);
    row.markModified('pendingEo');
  }
  await row.save();
  return row.toObject();
}

/** The bookmarklet exchange: import what EasyOrders has, hand back what still has to be applied. */
export async function syncExchange(coupons) {
  const result = await importFromEasyOrders(coupons);
  const rows = await CouponAssignment.find({ pendingEo: { $ne: null }, 'eo.id': { $exists: true } }).select('code eo pendingEo').lean();
  const pending = rows
    .filter((r) => r.pendingEo && Object.keys(r.pendingEo).length)
    .map((r) => ({ id: r.eo.id, code: r.code, patch: r.pendingEo }));
  return { ...result, pending };
}

// ---------------------------------------------------------------- lists

export async function listCoupons() {
  const rows = await CouponAssignment.find()
    .sort({ seq: 1 })
    .populate('order', 'easyOrdersShortId easyOrdersId')
    .populate('sentBy', 'name')
    .lean();
  const codes = rows.map((r) => r.code);
  const useRows = codes.length
    ? await Order.aggregate([
        { $match: { couponCode: { $in: codes }, sourceStatus: { $ne: 'canceled' }, deliveryStatus: { $ne: 'cancelled' } } },
        { $group: { _id: '$couponCode', uses: { $sum: 1 } } },
      ])
    : [];
  const uses = new Map(useRows.map((r) => [r._id, r.uses]));
  const flagged = await Order.find({ 'couponFlag.active': true })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('easyOrdersShortId easyOrdersId couponCode couponFlag customer.name customer.phone sourceStatus')
    .lean();
  const items = rows.map(({ history, ...r }) => ({
    ...r,
    uses: uses.get(r.code) || 0,
    lastChange: history?.length ? { at: history.at(-1).at, action: history.at(-1).action, label: ACTION_LABELS[history.at(-1).action] || history.at(-1).action } : null,
    // The few EasyOrders settings the page shows and edits (the full object stays in `eo`).
    settings: r.eo
      ? {
          value: r.eo.value,
          valueType: r.eo.value_type,
          usageLimit: r.eo.usage_limit,
          usageCount: r.eo.usage_count,
          isActive: r.eo.is_active,
          expiresAt: r.eo.expires_at,
        }
      : null,
  }));
  const bound = items.filter((r) => r.bound !== false);
  const assigned = bound.filter((r) => r.phoneNormalized);
  return {
    items,
    flagged,
    summary: {
      total: items.length,
      bound: bound.length,
      pool: bound.length - assigned.length,
      assigned: assigned.length,
      sent: assigned.filter((r) => r.sentAt).length,
      used: items.filter((r) => r.uses > 0).length,
      flagged: flagged.length,
      pendingSync: items.filter((r) => r.pendingEo).length,
      lastSyncAt: items.reduce((m, r) => (r.eoSyncedAt && (!m || r.eoSyncedAt > m) ? r.eoSyncedAt : m), null),
    },
  };
}

export async function listAttempts({ limit = 100 } = {}) {
  const attempts = await CouponAttempt.find().sort({ createdAt: -1 }).limit(limit).lean();
  const visitors = [...new Set(attempts.map((a) => a.visitorId).filter(Boolean))];
  const carts = visitors.length
    ? await StorefrontCart.find({ visitorId: { $in: visitors } })
        .sort({ lastActivityAt: -1 })
        .select('visitorId customer.name customer.phone customer.phoneNormalized')
        .lean()
    : [];
  const contact = new Map();
  for (const c of carts) if (!contact.has(c.visitorId) && (c.customer?.name || c.customer?.phone)) contact.set(c.visitorId, c.customer);
  return attempts.map((a) => ({ ...a, visitorContact: contact.get(a.visitorId) || null }));
}

/** Attach each order's customer coupon (by phone) to a list of orders. */
export async function attachCoupons(orders) {
  const phones = [...new Set(orders.map((o) => o.customer?.phoneNormalized).filter(Boolean))];
  if (!phones.length) return orders;
  const rows = await CouponAssignment.find({ phoneNormalized: { $in: phones } })
    .select('code phoneNormalized sentAt expiresAt')
    .lean();
  const byPhone = new Map(rows.map((r) => [r.phoneNormalized, r]));
  for (const o of orders) {
    const r = byPhone.get(o.customer?.phoneNormalized);
    o.couponAssignment = r ? { _id: r._id, code: r.code, sentAt: r.sentAt, expiresAt: r.expiresAt } : null;
  }
  return orders;
}
