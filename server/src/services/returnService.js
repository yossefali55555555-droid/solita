import { Order } from '../models/index.js';
import { RETURN_SYNC_STATUSES } from '../constants/statuses.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { recordEvent, userActor } from './auditService.js';
import { notify } from './notificationService.js';
import { enqueueStatusSync, processOperation } from './syncService.js';

/**
 * Review of failed / refused deliveries (رفض أو مرتجع).
 *
 * A courier reports a failed attempt (customer refused, did not pay, no
 * answer...) and the order becomes `failed`. It then waits in the admin
 * "returns review" list. The administrator either:
 *  - retries: reassigns the order (existing assignment / reopen flows), or
 *  - confirms the return: the order becomes `returned` and, like an approved
 *    delivery, the outcome is pushed to EasyOrders through the persistent
 *    sync-operation queue (retries, reconciliation, manual retry).
 */

const ORDER_FIELDS =
  'easyOrdersId easyOrdersShortId customer totalAmount currency paymentMethod sourceStatus deliveryStatus deliveryAttempts assignedTo returnInfo sync cod labels.printedAt parcels isDemo updatedAt createdAt';

export async function listReturns({ status = 'pending' }, { skip, limit }) {
  const query = status === 'returned' ? { deliveryStatus: 'returned' } : { deliveryStatus: 'failed' };
  const sort = status === 'returned' ? { 'returnInfo.at': -1, _id: -1 } : { updatedAt: 1, _id: 1 };
  const [items, total] = await Promise.all([
    Order.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(ORDER_FIELDS)
      .populate('assignedTo', 'name phone')
      .populate('deliveryAttempts.courier', 'name')
      .populate('returnInfo.by', 'name')
      .lean(),
    Order.countDocuments(query),
  ]);
  return {
    items: items.map((o) => ({ ...o, lastAttempt: o.deliveryAttempts?.at(-1) ?? null, deliveryAttempts: undefined })),
    total,
  };
}

/**
 * Confirm a failed delivery as a return. `easyOrdersStatus` is one of
 * RETURN_SYNC_STATUSES or 'none' (keep EasyOrders unchanged).
 */
export async function confirmReturn(admin, orderId, { reason, easyOrdersStatus = 'returning_from_delivery' }) {
  if (easyOrdersStatus !== 'none' && !RETURN_SYNC_STATUSES.includes(easyOrdersStatus)) {
    throw unprocessable('حالة EasyOrders غير مسموحة للمرتجع', 'INVALID_RETURN_STATUS');
  }
  const order = await Order.findById(orderId).lean();
  if (!order) throw notFound('الطلب غير موجود');
  if (order.deliveryStatus !== 'failed') {
    throw unprocessable('يمكن تأكيد المرتجع للطلبات التي سجل المندوب فشل تسليمها فقط', 'INVALID_TRANSITION');
  }

  const now = new Date();
  const lastAttempt = order.deliveryAttempts?.at(-1);
  const finalReason = reason || lastAttempt?.note || lastAttempt?.reason || '';
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, deliveryStatus: 'failed' },
    {
      $set: {
        deliveryStatus: 'returned',
        returnInfo: { at: now, by: admin._id, reason: finalReason, easyOrdersStatus: easyOrdersStatus === 'none' ? null : easyOrdersStatus },
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict('تغيرت حالة الطلب، حدّث الصفحة وحاول مرة أخرى');

  const event = await recordEvent({
    order: order._id,
    type: 'return_confirmed',
    actor: userActor(admin),
    previous: { deliveryStatus: 'failed' },
    next: { deliveryStatus: 'returned' },
    reason: finalReason || undefined,
    metadata: { easyOrdersStatus, attemptReason: lastAttempt?.reason, attempts: order.deliveryAttempts?.length || 0 },
  });
  if (order.assignedTo) {
    await notify(order.assignedTo, 'return_confirmed', `تم تأكيد الطلب (${order.easyOrdersId}) كمرتجع. أعد المنتج للإدارة.`, order._id);
  }

  let syncOperation = null;
  if (easyOrdersStatus !== 'none' && order.sourceStatus !== easyOrdersStatus) {
    try {
      const op = await enqueueStatusSync({
        order,
        targetStatus: easyOrdersStatus,
        trigger: 'return_confirmed',
        requestedBy: admin,
        idempotencyKey: `returned:${order._id}:${event._id}`,
      });
      syncOperation = await processOperation(op._id);
    } catch (err) {
      // The return itself is recorded; the sync stays visible on the sync page.
      logger.warn('Could not start return sync', { order: String(order._id), error: err.message });
    }
  }
  return { order: await Order.findById(orderId).lean(), syncOperation };
}
