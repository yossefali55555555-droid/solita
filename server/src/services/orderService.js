import mongoose from 'mongoose';
import { DeliveryReview, Order, SyncOperation, User } from '../models/index.js';
import { canTransition } from '../constants/statuses.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { escapeRegex } from '../utils/sanitize.js';
import { normalizePhone } from '../utils/phone.js';
import { recordEvent, userActor } from './auditService.js';
import { notify } from './notificationService.js';
import { enqueueStatusSync, processOperation } from './syncService.js';

const ASSIGNABLE = ['new', 'assigned', 'out_for_delivery', 'failed'];
const COURIER_FIELDS = 'name phone isActive';

// ---------------------------------------------------------------- queries

export async function listOrders(filters, { skip, limit }) {
  const query = {};
  if (filters.q) {
    const q = filters.q.trim();
    const rx = new RegExp(escapeRegex(q), 'i');
    const or = [{ easyOrdersId: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
    const phone = normalizePhone(q);
    if (phone.length >= 4) or.push({ 'customer.phoneNormalized': new RegExp(escapeRegex(phone)) });
    if (mongoose.isValidObjectId(q)) or.push({ _id: q });
    query.$or = or;
  }
  if (filters.sourceStatus) query.sourceStatus = filters.sourceStatus;
  if (filters.deliveryStatus) query.deliveryStatus = filters.deliveryStatus;
  if (filters.courier === 'unassigned') query.assignedTo = null;
  else if (filters.courier) query.assignedTo = filters.courier;
  if (filters.syncState) query['sync.state'] = filters.syncState;
  if (filters.from || filters.to) {
    query.createdAt = {};
    if (filters.from) query.createdAt.$gte = filters.from;
    if (filters.to) query.createdAt.$lte = filters.to;
  }

  const [items, total] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .select('-deliveryAttempts -items.options')
      .populate('assignedTo', COURIER_FIELDS)
      .lean(),
    Order.countDocuments(query),
  ]);
  return { items, total };
}

export async function getOrderForAdmin(orderId) {
  const order = await Order.findById(orderId)
    .populate('assignedTo', COURIER_FIELDS)
    .populate('assignedBy', 'name')
    .populate('deliveryAttempts.courier', 'name')
    .populate('cancellation.by', 'name')
    .lean();
  if (!order) throw notFound('الطلب غير موجود');
  const [reviews, syncOperations] = await Promise.all([
    DeliveryReview.find({ order: orderId })
      .sort({ submittedAt: -1 })
      .populate('courier', 'name phone')
      .populate('reviewer', 'name')
      .lean(),
    SyncOperation.find({ order: orderId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  return { order, reviews, syncOperations };
}

// ---------------------------------------------------------------- assignment

/**
 * Manually assign, reassign or unassign a courier. Never changes the
 * EasyOrders status.
 */
export async function assignOrder(admin, orderId, { courierId, note }) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw notFound('الطلب غير موجود');
  if (!ASSIGNABLE.includes(order.deliveryStatus)) {
    throw unprocessable('لا يمكن تغيير مندوب طلب في هذه الحالة', 'ASSIGNMENT_NOT_ALLOWED');
  }

  let courier = null;
  if (courierId) {
    courier = await User.findOne({ _id: courierId, role: 'courier' }).lean();
    if (!courier) throw notFound('المندوب غير موجود');
    if (!courier.isActive) throw unprocessable('لا يمكن التعيين لمندوب غير مفعل', 'COURIER_INACTIVE');
  }

  const previousCourierId = order.assignedTo ? String(order.assignedTo) : null;
  if (courierId && previousCourierId === String(courierId) && order.deliveryStatus === 'assigned') {
    return Order.findById(orderId).populate('assignedTo', COURIER_FIELDS).lean();
  }
  if (!courierId && !previousCourierId) throw unprocessable('الطلب غير معيّن لأي مندوب', 'NOT_ASSIGNED');

  const nextStatus = courierId ? 'assigned' : 'new';
  if (!canTransition(order.deliveryStatus, nextStatus)) {
    throw unprocessable('انتقال حالة غير مسموح', 'INVALID_TRANSITION');
  }

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, deliveryStatus: order.deliveryStatus, assignedTo: order.assignedTo ?? null },
    {
      $set: {
        assignedTo: courierId || null,
        assignedBy: courierId ? admin._id : null,
        assignedAt: courierId ? now : null,
        deliveryStatus: nextStatus,
      },
    },
    { returnDocument: 'after' },
  )
    .populate('assignedTo', COURIER_FIELDS)
    .lean();
  if (!updated) throw conflict('تم تعديل الطلب بواسطة مستخدم آخر، حدّث الصفحة وحاول مرة أخرى');

  const type = !courierId ? 'unassigned' : previousCourierId ? 'reassigned' : 'assigned';
  await recordEvent({
    order: order._id,
    type,
    actor: userActor(admin),
    previous: { assignedTo: previousCourierId, deliveryStatus: order.deliveryStatus },
    next: { assignedTo: courierId || null, courierName: courier?.name, deliveryStatus: nextStatus },
    reason: note,
  });

  if (courierId && previousCourierId !== String(courierId)) {
    await notify(courierId, 'order_assigned', `تم تعيين طلب جديد لك (${order.easyOrdersId})`, order._id);
  }
  if (previousCourierId && previousCourierId !== String(courierId || '')) {
    await notify(previousCourierId, 'order_unassigned', `تم سحب الطلب (${order.easyOrdersId}) منك`, order._id);
  }
  return updated;
}

// ---------------------------------------------------------------- admin status

/**
 * Administrative internal status changes:
 *  - cancelled: separate cancellation workflow (reason required). Pushes
 *    `canceled` to EasyOrders only when explicitly requested.
 *  - new: reopen a failed/cancelled order (removes the assignment).
 */
export async function adminChangeStatus(admin, orderId, body) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw notFound('الطلب غير موجود');
  const now = new Date();

  if (body.status === 'cancelled') {
    if (order.deliveryStatus === 'pending_delivery_review') {
      throw unprocessable('يوجد تقرير تسليم بانتظار المراجعة. ارفضه أولاً قبل إلغاء الطلب.', 'REVIEW_PENDING');
    }
    if (!canTransition(order.deliveryStatus, 'cancelled')) {
      throw unprocessable('لا يمكن إلغاء الطلب في حالته الحالية', 'INVALID_TRANSITION');
    }
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, deliveryStatus: order.deliveryStatus },
      {
        $set: {
          deliveryStatus: 'cancelled',
          cancellation: { reason: body.reason, by: admin._id, at: now, source: 'admin' },
        },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw conflict();
    const event = await recordEvent({
      order: order._id,
      type: 'order_cancelled',
      actor: userActor(admin),
      previous: { deliveryStatus: order.deliveryStatus },
      next: { deliveryStatus: 'cancelled' },
      reason: body.reason,
      metadata: { syncToEasyOrders: body.syncToEasyOrders },
    });
    if (order.assignedTo) {
      await notify(order.assignedTo, 'order_cancelled', `تم إلغاء الطلب (${order.easyOrdersId}). لا تقم بتسليمه.`, order._id);
    }
    let syncOperation = null;
    if (body.syncToEasyOrders && order.sourceStatus !== 'canceled') {
      const op = await enqueueStatusSync({
        order,
        targetStatus: 'canceled',
        trigger: 'order_cancelled',
        requestedBy: admin,
        idempotencyKey: `canceled:${order._id}:${event._id}`,
      });
      syncOperation = await processOperation(op._id);
    }
    return { order: await Order.findById(orderId).lean(), syncOperation };
  }

  // Reopen
  if (!['failed', 'cancelled'].includes(order.deliveryStatus)) {
    throw unprocessable('يمكن إعادة فتح الطلبات الفاشلة أو الملغاة فقط', 'INVALID_TRANSITION');
  }
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, deliveryStatus: order.deliveryStatus },
    { $set: { deliveryStatus: 'new', assignedTo: null, assignedBy: null, assignedAt: null } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict();
  await recordEvent({
    order: order._id,
    type: 'order_reopened',
    actor: userActor(admin),
    previous: { deliveryStatus: order.deliveryStatus, assignedTo: order.assignedTo },
    next: { deliveryStatus: 'new', assignedTo: null },
    reason: body.reason,
  });
  if (order.assignedTo) {
    await notify(order.assignedTo, 'order_unassigned', `تم سحب الطلب (${order.easyOrdersId}) منك`, order._id);
  }
  return { order: updated, syncOperation: null };
}

export async function clearSourceConflict(admin, orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, 'sourceConflict.active': true },
    { $set: { 'sourceConflict.active': false } },
    { returnDocument: 'after' },
  ).lean();
  if (!order) throw notFound('لا يوجد تعارض نشط لهذا الطلب');
  await recordEvent({ order: order._id, type: 'source_conflict_acknowledged', actor: userActor(admin) });
  return order;
}
