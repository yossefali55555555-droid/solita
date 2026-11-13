import { z } from 'zod';
import { EGYPT_MOBILE_REGEX, normalizePhone } from '../utils/phone.js';
import { pageQuery } from './common.js';

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
  z.object({ type: z.literal('page_view'), path: str(300).min(1), title: str(200).optional() }),
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
export const listCartsQuery = z.object({
  range: z.enum(['today', '3d', '7d', '30d', 'all']).optional(),
  status: z.enum(['active', 'open', 'contacted', 'converted', 'expired', 'all']).optional(),
  hasPhone: z.enum(['true', 'false']).optional(),
  notContacted: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});
