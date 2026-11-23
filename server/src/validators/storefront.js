import { z } from 'zod';
import { EGYPT_MOBILE_REGEX, normalizePhone } from '../utils/phone.js';
import { pageQuery } from './common.js';
import { DEVICES, OSES, SOURCES } from '../models/PageStat.js';

/**
 * Public storefront events (POST /api/public/events).
 *
 * The envelope is strict (unknown top-level fields → 400). Each event is
 * validated on its own: unknown fields are dropped, and an invalid event is
 * skipped and counted as `rejected` instead of failing the whole batch.
 */

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_CART_ITEMS = 30;
export const PUBLIC_BODY_LIMIT = '32kb';

const str = (max) => z.string().trim().max(max);

// Random id stored on the device (crypto.randomUUID() or a fallback).
export const visitorIdSchema = z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'visitorId غير صالح');

const productRef = z.object({
  slug: str(200).min(1),
  sku: str(100).optional(),
  name: str(200).optional(),
  price: z.number().min(0).max(1_000_000).optional(),
});

const cartItem = z.object({
  slug: str(200).min(1),
  sku: str(100).optional(),
  name: str(200).optional(),
  size: z.union([str(20), z.number().int().min(0).max(999).transform(String)]).optional(),
  qty: z.number().int().min(1).max(20),
  price: z.number().min(0).max(1_000_000), // EGP per unit, as shown on the site
});

const phone = z
  .string()
  .trim()
  .max(30)
  .transform(normalizePhone)
  .refine((v) => EGYPT_MOBILE_REGEX.test(v), 'رقم موبايل مصري غير صحيح');

export const storefrontEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('page_view'),
    path: str(300).min(1),
    title: str(200).optional(),
    device: z.enum(DEVICES).optional(),
    os: z.enum(OSES).optional(),
    src: z.enum(SOURCES).optional(),
  }),
  // Active seconds on a page. `part` reports are partial (tab hidden); the final one
  // (part false) carries the whole visit's `total`, whether the visitor went on to
  // another page (cont true) or left the site (cont false), and the scroll depth.
  z.object({
    type: z.literal('page_time'),
    path: str(300).min(1),
    title: str(200).optional(),
    seconds: z.number().min(0).max(7200).transform((n) => Math.round(n)),
    total: z.number().min(0).max(7200).transform((n) => Math.round(n)).optional(),
    part: z.boolean().optional(),
    cont: z.boolean().optional(),
    scroll: z.number().min(0).max(100).transform((n) => Math.round(n)).optional(),
    device: z.enum(DEVICES).optional(),
    os: z.enum(OSES).optional(),
    src: z.enum(SOURCES).optional(),
  }),
  z.object({ type: z.literal('product_view'), product: productRef }),
  z.object({ type: z.literal('cart_add'), item: cartItem }),
  z.object({
    type: z.literal('cart_remove'),
    item: cartItem.extend({ qty: z.number().int().min(1).max(20).optional(), price: z.number().min(0).max(1_000_000).optional() }),
  }),
  z.object({ type: z.literal('cart_snapshot'), items: z.array(cartItem).max(MAX_CART_ITEMS) }),
  z.object({ type: z.literal('checkout_contact'), name: str(120).optional(), phone }),
  z
    .object({
      type: z.literal('order_placed'),
      orderId: str(100).min(1).optional(),
      shortId: z.union([z.number().int().min(1), z.string().trim().regex(/^\d{1,12}$/).transform(Number)]).optional(),
      phone: phone.optional(),
    })
    .refine((v) => v.orderId || v.shortId, 'orderId أو shortId مطلوب'),
]);

export const eventsEnvelopeSchema = z.strictObject({
  visitorId: visitorIdSchema,
  newVisit: z.boolean().optional(),
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
});

// ---------- Admin ----------
export const pageStatsQuery = z.object({
  range: z.enum(['today', '7d', '30d', '90d']).optional(),
  device: z.enum(DEVICES).optional(),
  src: z.enum(SOURCES).optional(),
  type: z.enum(['home', 'product', 'collection', 'checkout', 'thanks', 'track', 'cart', 'page', 'search', 'other']).optional(),
});

export const importMissedBody = z.strictObject({ text: z.string().min(10).max(100_000) });

export const listMissedQuery = z.object({
  status: z.enum(['open', 'contacted', 'dismissed', 'all']).optional(),
  test: z.enum(['include', 'only']).optional(),
  reason: z.string().trim().max(200).optional(),
  priority: z.enum(['all', 'hot', 'done', 'unreachable', 'likely_test']).optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

export const bulkMissedBody = z
  .strictObject({
    ids: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1).max(500),
    contacted: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    isTest: z.boolean().optional(),
  })
  .refine((v) => v.contacted !== undefined || v.dismissed !== undefined || v.isTest !== undefined, 'لا توجد بيانات للتحديث');

export const updateMissedBody = z
  .strictObject({
    contacted: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    isTest: z.boolean().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'لا توجد بيانات للتحديث');

export const listCartsQuery = z.object({
  range: z.enum(['today', '3d', '7d', '30d', 'all']).optional(),
  status: z.enum(['active', 'open', 'contacted', 'converted', 'expired', 'all']).optional(),
  hasPhone: z.enum(['true', 'false']).optional(),
  notContacted: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

// Founder coupon codes are EasyOrders codes (letters, digits, - _), stored lowercase.
const couponCodeField = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Za-z0-9_-]*$/, 'الكود يحتوي على أحرف غير مسموحة')
  .transform((v) => v.toLowerCase());

export const updateFounderBody = z.strictObject({
  personalCode: couponCodeField.optional(),
  friendCode: couponCodeField.optional(),
  notes: str(1000).optional(),
});

export const couponCheckBody = z.strictObject({
  code: str(60),
  phone: str(40).optional(),
  // What the customer typed so far at checkout, and the device id (sol_vid), for the owner's attempts list.
  name: str(200).optional(),
  visitorId: str(64).optional(),
  stage: z.enum(['apply', 'submit']).optional(),
});

export const addCouponsBody = z.strictObject({
  codes: z.array(str(60).min(1)).min(1, 'أضف كودًا واحدًا على الأقل').max(500),
});

export const assignCouponBody = z.strictObject({
  phone: str(40).min(1),
  name: str(200).optional(),
});

// Full EasyOrders coupon objects (stored as they are; only `code` is required).
const eoCoupon = z.looseObject({ code: str(60).min(1) });
export const importCouponsBody = z.strictObject({ coupons: z.array(eoCoupon).min(1).max(1000) });

export const couponSettingsBody = z.strictObject({
  value: z.number().min(0).max(100).optional(),
  usageLimit: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
  bound: z.boolean().optional(),
});

const couponDate = z
  .string()
  .min(1)
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), 'تاريخ غير صالح');

export const couponDatesBody = z
  .strictObject({
    sentAt: z.union([z.null(), couponDate]).optional(),
    expiresAt: couponDate.optional(),
  })
  .refine((b) => b.sentAt !== undefined || b.expiresAt !== undefined, 'حدد تاريخًا واحدًا على الأقل');
