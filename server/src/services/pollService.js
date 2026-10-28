import { IntegrationState, Order } from '../models/index.js';
import { EasyOrdersError, getOrder, getOrderByShortId, isEasyOrdersConfigured } from '../integrations/easyorders/client.js';
import { normalizeEasyOrdersOrder } from '../integrations/easyorders/normalize.js';
import { upsertOrderFromSource } from './sourceOrderService.js';
import { recordEvent } from './auditService.js';
import { badRequest, notFound, serviceUnavailable, AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * EasyOrders → Solita pull sync, a fallback for when webhooks do not arrive.
 *
 * The public API documents no "list orders" endpoint, only:
 *   GET /orders/:order_id   and   GET /orders/short/:short_id
 * `short_id` is the merchant's sequential order number, so new orders are
 * discovered by asking for the next numbers after the highest one we know
 * until a few consecutive numbers are not found. Known open orders are also
 * re-read to pick up status changes made in EasyOrders.
 *
 * Orders are stored through upsertOrderFromSource(), keyed by the EasyOrders
 * id, so an order that arrives by webhook and by polling is stored once.
 * Nothing here pushes to EasyOrders, so it cannot create a sync loop.
 */

const STATE_KEY = 'easyorders_poll';
const LEASE_MS = 60_000;
const FINAL_DELIVERY = ['delivered', 'cancelled'];
const FINAL_SOURCE = ['delivered', 'canceled', 'refunded'];

// Kept small so a poll never uses more than ~13 of the 35 requests/minute budget
// that outbound status updates (e.g. "delivered") also rely on.
export const POLL_DEFAULTS = Object.freeze({ maxNewLookups: 10, missTolerance: 3, refreshLimit: 3 });

function isNotFound(err) {
  return err instanceof EasyOrdersError && err.kind === 'client' && err.status === 404;
}

async function storeFromSource(raw, via) {
  const normalized = normalizeEasyOrdersOrder(raw);
  const { order, outcome } = await upsertOrderFromSource(normalized, { via });
  return { order, outcome };
}

async function highestKnownShortId(state) {
  const top = await Order.findOne({ easyOrdersShortId: { $gt: 0 }, isDemo: { $ne: true } })
    .sort({ easyOrdersShortId: -1 })
    .select('easyOrdersShortId')
    .lean();
  return Math.max(state?.lastShortId || 0, top?.easyOrdersShortId || 0);
}

async function acquireLease() {
  const now = new Date();
  await IntegrationState.updateOne({ key: STATE_KEY }, { $setOnInsert: { lastShortId: 0 } }, { upsert: true }).catch(
    (err) => {
      if (err?.code !== 11000) throw err;
    },
  );
  return IntegrationState.findOneAndUpdate(
    { key: STATE_KEY, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } },
    { returnDocument: 'after' },
  ).lean();
}

/**
 * Pull new orders (by order number) and refresh open orders.
 * Returns a summary; never throws for EasyOrders errors.
 */
export async function pollEasyOrders(options = {}) {
  const { maxNewLookups, missTolerance, refreshLimit } = { ...POLL_DEFAULTS, ...options };
  if (!isEasyOrdersConfigured()) return { status: 'not_configured' };

  const state = await acquireLease();
  if (!state) return { status: 'already_running' };

  const summary = { status: 'ok', created: 0, updated: 0, checkedNumbers: [], refreshed: 0, errors: [] };
  let cursor = await highestKnownShortId(state);
  let stopReason = null;

  try {
    if (!cursor) {
      summary.status = 'needs_start';
    } else {
      let misses = 0;
      let next = cursor + 1;
      for (let i = 0; i < maxNewLookups && misses < missTolerance; i += 1, next += 1) {
        summary.checkedNumbers.push(next);
        try {
          const raw = await getOrderByShortId(next);
          const { outcome } = await storeFromSource(raw, 'poll');
          if (outcome === 'created') summary.created += 1;
          else summary.updated += 1;
          cursor = next;
          misses = 0;
        } catch (err) {
          if (isNotFound(err)) {
            misses += 1;
            continue;
          }
          stopReason = err;
          break;
        }
      }
    }

    // Re-read open orders so status changes made in EasyOrders show up even
    // without a status webhook. Least recently synced first.
    if (!stopReason && refreshLimit > 0) {
      const open = await Order.find({
        isDemo: { $ne: true },
        deliveryStatus: { $nin: FINAL_DELIVERY },
        sourceStatus: { $nin: FINAL_SOURCE },
      })
        .sort({ lastSyncedFromSourceAt: 1 })
        .limit(refreshLimit)
        .select('easyOrdersId')
        .lean();
      for (const o of open) {
        try {
          const raw = await getOrder(o.easyOrdersId);
          const { outcome } = await storeFromSource(raw, 'poll_refresh');
          if (outcome !== 'stale') summary.refreshed += 1;
        } catch (err) {
          if (isNotFound(err)) continue;
          stopReason = err;
          break;
        }
      }
    }
  } finally {
    if (stopReason) {
      summary.errors.push({ kind: stopReason.kind || 'error', message: String(stopReason.message).slice(0, 300) });
      if (stopReason instanceof EasyOrdersError && stopReason.kind === 'rate_limited') summary.status = 'rate_limited';
      else summary.status = 'partial';
      if (!(stopReason instanceof EasyOrdersError)) logger.error('EasyOrders poll failed', { error: stopReason.message });
    }
    await IntegrationState.updateOne(
      { key: STATE_KEY },
      {
        $set: { lockedUntil: null, lastRunAt: new Date(), lastResult: summary },
        $max: { lastShortId: cursor || 0 },
      },
    );
  }

  logger.info('EasyOrders poll finished', {
    status: summary.status,
    created: summary.created,
    updated: summary.updated,
    refreshed: summary.refreshed,
    lastShortId: cursor || 0,
  });
  return { ...summary, lastShortId: cursor || 0 };
}

export async function getPollStatus() {
  const state = await IntegrationState.findOne({ key: STATE_KEY }).lean();
  return {
    apiConfigured: isEasyOrdersConfigured(),
    lastShortId: await highestKnownShortId(state),
    lastRunAt: state?.lastRunAt || null,
    lastResult: state?.lastResult || null,
  };
}

/**
 * Admin action: import one order by its order number (short_id) or its
 * EasyOrders id. Also moves the polling cursor forward, so importing the
 * latest order once is enough to start automatic polling.
 */
export async function importOrder({ shortId, orderId }, actor) {
  if (!isEasyOrdersConfigured()) {
    throw serviceUnavailable('مفتاح EasyOrders API غير مضاف، أضف EASYORDERS_API_KEY أولاً', 'EASYORDERS_NOT_CONFIGURED');
  }
  if (!shortId && !orderId) throw badRequest('أدخل رقم الطلب');

  let raw;
  try {
    raw = shortId ? await getOrderByShortId(shortId) : await getOrder(orderId);
  } catch (err) {
    if (isNotFound(err)) throw notFound('لا يوجد طلب بهذا الرقم في EasyOrders');
    if (err instanceof EasyOrdersError) {
      if (err.kind === 'rate_limited') {
        throw new AppError(429, 'EASYORDERS_RATE_LIMITED', 'تم تجاوز حد طلبات EasyOrders، حاول بعد دقيقة');
      }
      if (err.kind === 'client' && (err.status === 401 || err.status === 403)) {
        throw new AppError(502, 'EASYORDERS_UNAUTHORIZED', 'EasyOrders رفض المفتاح. تأكد من المفتاح وصلاحية orders:read');
      }
      throw new AppError(502, 'EASYORDERS_ERROR', `تعذر جلب الطلب من EasyOrders (${err.kind})`);
    }
    throw err;
  }

  const { order, outcome } = await storeFromSource(raw, 'manual_import');
  await recordEvent({
    order: order?._id,
    type: 'manual_import',
    actor,
    metadata: { shortId: shortId || undefined, outcome },
  });
  if (order?.easyOrdersShortId) {
    await IntegrationState.updateOne(
      { key: STATE_KEY },
      { $max: { lastShortId: order.easyOrdersShortId } },
      { upsert: true },
    );
  }
  return { order, outcome };
}
