import { NOT_TEST } from '../models/Order.js';
import { Founder, Order, SiteSettings } from '../models/index.js';
import { FOUNDER_BENEFIT_MONTHS } from '../models/Founder.js';
import { mergeWithDefaults } from '../validators/siteSettings.js';
import { isDuplicateKeyError, notFound, unprocessable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { FULL_VIEWER } from './visibilityService.js';

/**
 * Founders ("أوائل سوليتا"): the first `cap` customers (by delivery approval
 * time) get a number. The number is assigned when an order is approved as
 * delivered, once per customer phone and once per order.
 */

export async function founderSettings() {
  const doc = await SiteSettings.findOne({ key: 'site' }, { settings: 1 }).lean();
  return mergeWithDefaults(doc?.settings).founders;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Give the order's customer the next founder number when eligible.
 * Never throws and never changes the order, so delivery approval is unaffected.
 * Returns the new Founder, or null.
 */
export async function assignFounderForOrder(order) {
  try {
    const cfg = await founderSettings();
    if (!cfg.enabled || !order || order.isDemo || order.deliveryStatus !== 'delivered') return null;
    const phone = order.customer?.phoneNormalized;
    if (!phone) return null;
    if (await Founder.exists({ $or: [{ order: order._id }, { phoneNormalized: phone }] })) return null;

    // Retry on a number collision from a concurrent approval.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await Founder.findOne().sort({ number: -1 }).select('number').lean();
      const number = (last?.number || 0) + 1;
      if (number > cfg.cap) return null;
      const joinedAt = order.deliveredAt || new Date();
      try {
        return await Founder.create({
          number,
          name: order.customer?.name || '',
          phone: order.customer?.phone || '',
          phoneNormalized: phone,
          order: order._id,
          joinedAt,
          benefitUntil: addMonths(joinedAt, FOUNDER_BENEFIT_MONTHS),
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        if (await Founder.exists({ $or: [{ order: order._id }, { phoneNormalized: phone }] })) return null;
      }
    }
    return null;
  } catch (err) {
    logger.error('Founder assignment failed', { error: err.message });
    return null;
  }
}

/** Orders that used a friend code and were not cancelled. */
async function friendOrderCounts(codes) {
  if (!codes.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { ...NOT_TEST, couponCode: { $in: codes }, sourceStatus: { $nin: ['canceled'] }, deliveryStatus: { $ne: 'cancelled' } } },
    { $group: { _id: '$couponCode', orders: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.orders]));
}

export async function listFounders(viewer = FULL_VIEWER) {
  const [founders, cfg] = await Promise.all([
    Founder.find().select(viewer.phone ? '-__v' : '-phone -phoneNormalized').sort({ number: 1 }).populate('order', 'easyOrdersShortId easyOrdersId totalAmount').lean(),
    founderSettings(),
  ]);
  const friend = await friendOrderCounts(founders.map((f) => f.friendCode).filter(Boolean));
  const usedPersonal = await friendOrderCounts(founders.map((f) => f.personalCode).filter(Boolean));
  const items = founders.map((f) => {
    const referrals = f.friendCode ? friend.get(f.friendCode) || 0 : 0;
    return {
      ...f,
      referrals,
      drawEntries: 1 + referrals,
      personalUses: f.personalCode ? usedPersonal.get(f.personalCode) || 0 : 0,
    };
  });
  return { items, summary: counter(founders.length, cfg) };
}

function counter(taken, cfg) {
  return {
    enabled: cfg.enabled,
    cap: cfg.cap,
    taken,
    remaining: Math.max(0, cfg.cap - taken),
    showCounter: cfg.enabled && taken >= cfg.showCounterAfter,
  };
}

/** What the storefront may read: counts only, never a customer. */
export async function publicFounderCounter() {
  const [taken, cfg] = await Promise.all([Founder.countDocuments(), founderSettings()]);
  return counter(taken, cfg);
}

export async function updateFounder(id, patch) {
  const founder = await Founder.findById(id);
  if (!founder) throw notFound('المؤسس غير موجود');
  for (const k of ['personalCode', 'friendCode', 'notes']) if (patch[k] !== undefined) founder[k] = patch[k];
  const codes = [founder.personalCode, founder.friendCode].filter(Boolean);
  if (codes.length === 2 && codes[0] === codes[1]) throw unprocessable('كود المؤسس وكود الصاحب لا يمكن أن يكونا نفس الكود');
  for (const k of ['personalCode', 'friendCode']) {
    if (!founder[k]) continue;
    const clash = await Founder.exists({
      _id: { $ne: founder._id },
      $or: [{ personalCode: founder[k] }, { friendCode: founder[k] }],
    });
    if (clash) throw unprocessable('هذا الكود مستخدم عند مؤسس آخر');
  }
  await founder.save();
  return founder.toObject();
}
