import { isCashOnDelivery } from '../../constants/statuses.js';
import { toMinorOrZero } from '../../utils/money.js';
import { normalizePhone } from '../../utils/phone.js';

/**
 * Map an EasyOrders order object (webhook "order created" payload or the
 * GET order response; both share the documented shape) to Solita's
 * source-controlled order fields.
 *
 * Documented fields used: id, store_id, created_at, updated_at, cost,
 * shipping_cost, total_cost, status, full_name, phone, government, address,
 * payment_method, cart_items[{ id, product_id, variant_id, price, quantity,
 * product{ name, sku }, variant{ variation_props[{ variation, variation_prop }] } }].
 *
 * Missing or partial fields never throw; they fall back to empty values.
 */

const str = (v, max = 1000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const optStr = (v, max) => {
  const s = str(v, max);
  return s ? s : undefined;
};

function parseDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function normalizeItem(item) {
  const product = item?.product && typeof item.product === 'object' ? item.product : {};
  const variant = item?.variant && typeof item.variant === 'object' ? item.variant : null;
  const props = Array.isArray(variant?.variation_props) ? variant.variation_props : [];
  const quantity = Number.parseInt(item?.quantity, 10);
  return {
    externalId: optStr(item?.id, 100),
    productId: optStr(item?.product_id ?? product.id, 100),
    variantId: optStr(item?.variant_id ?? variant?.id, 100),
    name: str(product.name, 300) || 'منتج بدون اسم',
    sku: optStr(product.sku, 120),
    quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
    price: toMinorOrZero(item?.price ?? variant?.sale_price ?? variant?.price ?? product.price),
    options: props.length
      ? props.slice(0, 20).map((p) => ({ name: str(p?.variation, 100), value: str(p?.variation_prop, 200) }))
      : undefined,
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** First non-empty string found under any of the keys, in any of the objects. */
function pick(objs, keys) {
  for (const o of objs) {
    if (!isObj(o)) continue;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
    }
  }
  return undefined;
}

const intOrUndef = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.round(Number(v))) : undefined);

/**
 * Visit-session data: EasyOrders documents `metadata.tracking`
 * { first_visit_at, first_order_at, orders_count, sessions_count,
 *   visit_duration_seconds, pages_visited[], referrer } and `ip_country`.
 * Campaign fields are not documented, so common UTM spellings are looked up
 * in tracking, metadata and the payload itself; whatever else metadata holds
 * is kept (size-limited) in `extra`. Returns undefined when nothing is there,
 * so a payload without a session never wipes stored data.
 */
export function normalizeSession(payload) {
  if (!isObj(payload)) return undefined;
  const meta = isObj(payload.metadata) ? payload.metadata : null;
  const tracking = isObj(meta?.tracking) ? meta.tracking : null;
  const where = [tracking, meta, isObj(meta?.utm) ? meta.utm : null, isObj(tracking?.utm) ? tracking.utm : null, payload];
  const out = {};
  const put = (k, v) => {
    if (v !== undefined && v !== '') out[k] = v;
  };
  if (tracking) {
    put('firstVisitAt', parseDate(tracking.first_visit_at));
    put('firstOrderAt', parseDate(tracking.first_order_at));
    put('ordersCount', intOrUndef(tracking.orders_count));
    put('sessionsCount', intOrUndef(tracking.sessions_count));
    put('visitDurationSeconds', intOrUndef(tracking.visit_duration_seconds));
    if (Array.isArray(tracking.pages_visited)) {
      put('pagesVisited', tracking.pages_visited.filter((p) => typeof p === 'string').slice(0, 60).map((p) => p.slice(0, 300)));
    }
    put('referrer', optStr(tracking.referrer, 300));
  }
  put('ipCountry', optStr(payload.ip_country, 10));
  put('utmSource', pick(where, ['utm_source', 'source', 'campaign_source', 'utmSource']));
  put('utmCampaign', pick(where, ['utm_campaign', 'campaign', 'campaign_name', 'utmCampaign']));
  if (meta) {
    const rest = { ...meta };
    delete rest.tracking;
    const json = JSON.stringify(rest);
    if (json && json !== '{}' && json.length <= 3000) out.extra = rest;
  }
  return Object.keys(out).length ? out : undefined;
}

export function extractExternalOrderId(payload) {
  const id = payload?.id ?? payload?.order_id;
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s && s.length <= 100 ? s : null;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

/**
 * Returns only the fields present in the payload (missing keys stay
 * undefined), so a partial payload never wipes existing data.
 */
export function normalizeEasyOrdersOrder(payload) {
  const easyOrdersId = extractExternalOrderId(payload);
  if (!easyOrdersId) throw new Error('Order payload has no id');

  const items = Array.isArray(payload.cart_items) ? payload.cart_items.slice(0, 200).map(normalizeItem) : undefined;
  const subtotal = has(payload, 'cost')
    ? toMinorOrZero(payload.cost)
    : items
      ? items.reduce((acc, i) => acc + i.price * i.quantity, 0)
      : undefined;
  const shippingFee = has(payload, 'shipping_cost') ? toMinorOrZero(payload.shipping_cost) : undefined;
  const totalAmount = has(payload, 'total_cost') ? toMinorOrZero(payload.total_cost) : undefined;
  // EasyOrders does not send an explicit discount field; it is derived when
  // all three amounts are known.
  const discount =
    subtotal !== undefined && shippingFee !== undefined && totalAmount !== undefined
      ? Math.max(0, subtotal + shippingFee - totalAmount)
      : undefined;
  const paymentMethod = has(payload, 'payment_method') ? optStr(payload.payment_method, 60) : undefined;

  const couponCode = has(payload, 'coupon_code') ? optStr(payload.coupon_code, 60)?.toLowerCase() : undefined;
  const couponDiscount = has(payload, 'coupon_discount') ? toMinorOrZero(payload.coupon_discount) : undefined;

  const customer = {};
  if (has(payload, 'full_name')) customer.name = str(payload.full_name, 200);
  if (has(payload, 'phone')) {
    customer.phone = str(payload.phone, 40);
    customer.phoneNormalized = normalizePhone(customer.phone);
  }
  if (has(payload, 'government')) customer.government = str(payload.government, 120);
  if (has(payload, 'address')) customer.address = str(payload.address, 1000);

  return {
    easyOrdersId,
    session: normalizeSession(payload),
    storeId: has(payload, 'store_id') ? optStr(payload.store_id, 100) : undefined,
    customer,
    items,
    subtotal,
    shippingFee,
    discount,
    totalAmount,
    paymentMethod,
    couponCode,
    couponDiscount,
    shortId: parseShortId(payload.short_id),
    sourceStatus: has(payload, 'status') ? optStr(payload.status, 60) : undefined,
    sourceCreatedAt: parseDate(payload.created_at),
    sourceUpdatedAt: parseDate(payload.updated_at),
    isCod: paymentMethod !== undefined ? isCashOnDelivery(paymentMethod) : undefined,
  };
}

/** `short_id` is the documented numeric order number; anything else is ignored. */
export function parseShortId(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** A payload is "complete" when it carries everything needed to create an order. */
export function isCompleteOrderPayload(payload) {
  return (
    payload &&
    Array.isArray(payload.cart_items) &&
    has(payload, 'total_cost') &&
    has(payload, 'full_name') &&
    has(payload, 'address') &&
    has(payload, 'status')
  );
}
