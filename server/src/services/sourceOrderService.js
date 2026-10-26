import { Order } from '../models/index.js';
import { paymentStatusFromSource } from '../constants/statuses.js';
import { isDuplicateKeyError } from '../utils/errors.js';
import { EASYORDERS_ACTOR, recordEvent } from './auditService.js';
import { notify } from './notificationService.js';

/**
 * EasyOrders → Solita: apply source data to orders.
 *
 * Only source-controlled fields are written. Internal fields (assignment,
 * delivery status, delivery attempts, reviews, cash/remittance links) are
 * never overwritten, except for the documented cancellation rule in
 * applySourceStatusChange().
 */

const CANCELLABLE_INTERNAL = ['new', 'assigned', 'out_for_delivery', 'failed'];

function codExpected(order) {
  if (!order.cod?.isCod) return 0;
  if (['paid', 'refunded'].includes(order.paymentStatus)) return 0;
  return order.totalAmount || 0;
}

function buildSourceSet(n, now) {
  const set = { lastSyncedFromSourceAt: now };
  const assign = (key, value) => {
    if (value !== undefined) set[key] = value;
  };
  assign('storeId', n.storeId);
  for (const [k, v] of Object.entries(n.customer || {})) assign(`customer.${k}`, v);
  assign('items', n.items);
  assign('subtotal', n.subtotal);
  assign('shippingFee', n.shippingFee);
  assign('discount', n.discount);
  assign('totalAmount', n.totalAmount);
  assign('paymentMethod', n.paymentMethod);
  assign('cod.isCod', n.isCod);
  assign('sourceCreatedAt', n.sourceCreatedAt);
  assign('sourceUpdatedAt', n.sourceUpdatedAt);
  return set;
}

/**
 * Upsert an order by easyOrdersId from normalized source data.
 * Out-of-order protection: when the payload carries updated_at, it is only
 * applied if it is not older than the stored sourceUpdatedAt.
 *
 * Returns { order, outcome: 'created' | 'updated' | 'stale' }.
 */
export async function upsertOrderFromSource(n, { via = 'webhook', isDemo = false } = {}) {
  const now = new Date();
  const filter = { easyOrdersId: n.easyOrdersId };
  if (n.sourceUpdatedAt) {
    filter.$or = [{ sourceUpdatedAt: null }, { sourceUpdatedAt: { $lte: n.sourceUpdatedAt } }];
  }
  const set = buildSourceSet(n, now);
  const insertOnly = { deliveryStatus: 'new', isDemo };

  let previous;
  for (let attempt = 0; ; attempt += 1) {
    try {
      previous = await Order.findOneAndUpdate(
        filter,
        { $set: set, $setOnInsert: insertOnly },
        { upsert: true, returnDocument: 'before', runValidators: true, setDefaultsOnInsert: true },
      ).lean();
      break;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // The filter did not match an existing order, so the upsert tried to
      // insert a duplicate: either the payload is stale, or a concurrent
      // insert won the race. Retry once to tell them apart.
      if (attempt >= 1) {
        const existing = await Order.findOne({ easyOrdersId: n.easyOrdersId });
        await recordEvent({
          order: existing?._id,
          type: 'stale_source_update_ignored',
          actor: EASYORDERS_ACTOR,
          metadata: { via, payloadUpdatedAt: n.sourceUpdatedAt, storedUpdatedAt: existing?.sourceUpdatedAt },
        });
        return { order: existing, outcome: 'stale' };
      }
    }
  }

  const order = await Order.findOne({ easyOrdersId: n.easyOrdersId });
  const created = !previous;

  if (created) {
    await recordEvent({
      order: order._id,
      type: 'order_imported',
      actor: EASYORDERS_ACTOR,
      next: { sourceStatus: n.sourceStatus, totalAmount: order.totalAmount },
      metadata: { via },
    });
  } else {
    const changed = Object.keys(set).filter((k) => !['lastSyncedFromSourceAt'].includes(k));
    await recordEvent({
      order: order._id,
      type: 'source_updated',
      actor: EASYORDERS_ACTOR,
      metadata: { via, fields: changed },
    });
  }

  const previousStatus = created ? null : previous.sourceStatus;
  if (n.sourceStatus !== undefined && n.sourceStatus !== previousStatus) {
    await applySourceStatusChange(order, n.sourceStatus, { via, created });
  } else {
    await refreshCodExpectation(order);
  }

  return { order: await Order.findById(order._id), outcome: created ? 'created' : 'updated' };
}

async function refreshCodExpectation(order) {
  if (order.cod?.remittance) return; // already part of a cash remittance: frozen
  const expected = codExpected(order);
  if (expected !== order.cod?.expectedAmount) {
    await Order.updateOne({ _id: order._id, 'cod.remittance': null }, { $set: { 'cod.expectedAmount': expected } });
  }
}

/**
 * Apply a new EasyOrders status to an order and its derived values.
 *
 * Rules:
 *  - The raw status is stored as-is (unknown values are accepted).
 *  - paymentStatus is derived from the source status.
 *  - `canceled` cancels the internal workflow only while the order has not
 *    reached supervisor review; otherwise a visible conflict flag is raised.
 *  - `delivered` set directly in EasyOrders never marks the internal order
 *    delivered (supervisor approval is mandatory); a conflict flag is raised.
 *  - Nothing here triggers an outbound sync, which rules out sync loops.
 */
export async function applySourceStatusChange(
  orderDoc,
  newStatus,
  { via = 'webhook', created = false, paymentRefId, needsVerification = false, echo = false } = {},
) {
  const now = new Date();
  const order = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const previousStatus = created ? null : order.sourceStatus ?? null;
  const paymentStatus = paymentStatusFromSource(newStatus, order.paymentStatus);

  const set = {
    sourceStatus: newStatus,
    sourceStatusUpdatedAt: now,
    sourceStatusNeedsVerification: needsVerification,
    paymentStatus,
  };
  if (paymentRefId) set.paymentRefId = String(paymentRefId).slice(0, 200);
  if (!order.cod?.remittance) set['cod.expectedAmount'] = codExpected({ ...order, paymentStatus });

  let cancelled = false;
  if (newStatus === 'canceled' && CANCELLABLE_INTERNAL.includes(order.deliveryStatus)) {
    const res = await Order.updateOne(
      { _id: order._id, deliveryStatus: order.deliveryStatus },
      {
        $set: {
          ...set,
          deliveryStatus: 'cancelled',
          cancellation: { reason: 'تم إلغاء الطلب من EasyOrders', at: now, source: 'easyorders' },
        },
      },
    );
    cancelled = res.modifiedCount === 1;
  }
  if (!cancelled) {
    if (newStatus === 'canceled' && ['pending_delivery_review', 'delivered'].includes(order.deliveryStatus)) {
      set.sourceConflict = {
        active: true,
        message: 'تم إلغاء الطلب في EasyOrders بعد تسليمه أو أثناء مراجعة التسليم',
        at: now,
      };
    } else if (newStatus === 'delivered' && order.deliveryStatus !== 'delivered' && !echo) {
      set.sourceConflict = {
        active: true,
        message: 'تم تعيين الطلب كمُسلَّم في EasyOrders دون موافقة المشرف في النظام',
        at: now,
      };
    }
    await Order.updateOne({ _id: order._id }, { $set: set });
  }

  await recordEvent({
    order: order._id,
    type: echo ? 'source_status_echo' : 'source_status_changed',
    actor: EASYORDERS_ACTOR,
    previous: { sourceStatus: previousStatus },
    next: { sourceStatus: newStatus },
    metadata: { via, needsVerification, ...(set.sourceConflict ? { conflict: set.sourceConflict.message } : {}) },
  });

  if (cancelled) {
    await recordEvent({
      order: order._id,
      type: 'order_cancelled',
      actor: EASYORDERS_ACTOR,
      previous: { deliveryStatus: order.deliveryStatus },
      next: { deliveryStatus: 'cancelled' },
      reason: 'تم إلغاء الطلب من EasyOrders',
    });
    if (order.assignedTo) {
      await notify(order.assignedTo, 'order_cancelled', 'تم إلغاء أحد طلباتك من المتجر. لا تقم بتسليمه.', order._id);
    }
  }
}
