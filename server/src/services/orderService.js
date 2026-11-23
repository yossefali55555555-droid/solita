import mongoose from 'mongoose';
import { DeliveryReview, Order, SyncOperation, User } from '../models/index.js';
import { canTransition } from '../constants/statuses.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { escapeRegex } from '../utils/sanitize.js';
import { normalizePhone } from '../utils/phone.js';
import { recordEvent, userActor } from './auditService.js';
import { notify } from './notificationService.js';
import { enqueueStatusSync, processOperation } from './syncService.js';
import { parcelsAfterAssignment } from './labelService.js';
import { attachCoupons } from './couponService.js';
import { attachCustomerHistory } from './customerRiskService.js';
import { addOrderNote, EasyOrdersError } from '../integrations/easyorders/client.js';

const ASSIGNABLE = ['new', 'assigned', 'out_for_delivery', 'failed'];
const COURIER_FIELDS = 'name phone isActive';

// ---------------------------------------------------------------- queries

export async function listOrders(filters, { skip, limit }) {
  const query = {};
  // Cleared orders are hidden from the dashboard list unless asked for.
  if (filters.cleared === 'only') query.dashboardHiddenAt = { $ne: null };
  else if (filters.cleared !== 'include') query.dashboardHiddenAt = null;
  // Orders an admin marked as test are hidden by default.
  if (filters.test === 'only') query.isTest = true;
  else if (filters.test !== 'include') query.isTest = { $ne: true };
  if (filters.q) {
    const q = filters.q.trim();
    const rx = new RegExp(escapeRegex(q), 'i');
    const or = [{ easyOrdersId: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
    const phone = normalizePhone(q);
    if (phone.length >= 4) or.push({ 'customer.phoneNormalized': new RegExp(escapeRegex(phone)) });
    if (mongoose.isValidObjectId(q)) or.push({ _id: q });
    const number = q.replace(/^#/, '');
    if (/^\d{1,12}$/.test(number)) or.push({ easyOrdersShortId: Number(number) });
    query.$or = or;
  }
  if (filters.sourceStatus) query.sourceStatus = filters.sourceStatus;
  if (filters.deliveryStatus) query.deliveryStatus = filters.deliveryStatus;
  if (filters.courier === 'unassigned') query.assignedTo = null;
  else if (filters.courier) query.assignedTo = filters.courier;
  if (filters.syncState) query['sync.state'] = filters.syncState;
  if (filters.unconfirmed) query.sourceStatus = 'pending';
  if (filters.couponFlagged) query['couponFlag.active'] = true;
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
      .select('-deliveryAttempts')
      .populate('assignedTo', COURIER_FIELDS)
      .lean(),
    Order.countDocuments(query),
  ]);
  await attachCoupons(items);
  await attachCustomerHistory(items);
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
  await attachCoupons([order]);
  await attachCustomerHistory([order]);
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
        parcels: parcelsAfterAssignment(order, courierId),
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
  if (!['failed', 'cancelled', 'returned'].includes(order.deliveryStatus)) {
    throw unprocessable('يمكن إعادة فتح الطلبات الفاشلة أو الملغاة أو المرتجعة فقط', 'INVALID_TRANSITION');
  }
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, deliveryStatus: order.deliveryStatus },
    {
      $set: { deliveryStatus: 'new', assignedTo: null, assignedBy: null, assignedAt: null },
      ...(order.deliveryStatus === 'returned' ? { $unset: { returnInfo: 1 } } : {}),
    },
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

// ---------------------------------------------------------------- notes

async function pushNote(order, note) {
  if (!order.storeId) return { sync: 'failed', syncError: 'لا يوجد store_id للطلب، حدّث الطلب من EasyOrders أولاً' };
  try {
    await addOrderNote({ orderId: order.easyOrdersId, storeId: order.storeId, note: note.text, type: note.type });
    return { sync: 'synced', syncError: '' };
  } catch (err) {
    const msg = err instanceof EasyOrdersError ? err.message : 'تعذر الإرسال إلى EasyOrders';
    return { sync: 'failed', syncError: String(msg).slice(0, 300) };
  }
}

/**
 * Add a note to an order. It is saved here first, then sent to EasyOrders
 * (public notes show on the customer's tracking page). A failed send keeps
 * the note and can be retried.
 */
export async function addNote(admin, orderId, { text, type }) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw notFound('الطلب غير موجود');
  const note = { text, type, by: admin._id, byName: admin.name || '', at: new Date() };
  const result = await pushNote(order, note);
  const updated = await Order.findOneAndUpdate(
    { _id: orderId },
    { $push: { notes: { ...note, ...result } } },
    { returnDocument: 'after' },
  ).lean();
  await recordEvent({ order: order._id, type: 'order_note_added', actor: userActor(admin), next: { noteType: type, sync: result.sync } });
  return { order: updated, sync: result.sync, syncError: result.syncError };
}

export async function retryNote(admin, orderId, noteId) {
  const order = await Order.findById(orderId).lean();
  const note = order?.notes?.find((n) => String(n._id) === String(noteId));
  if (!note) throw notFound('الملاحظة غير موجودة');
  if (note.sync === 'synced') return { order, sync: 'synced', syncError: '' };
  const result = await pushNote(order, note);
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, 'notes._id': noteId },
    { $set: { 'notes.$.sync': result.sync, 'notes.$.syncError': result.syncError } },
    { returnDocument: 'after' },
  ).lean();
  return { order: updated, sync: result.sync, syncError: result.syncError };
}

// ---------------------------------------------------------------- test flag + bulk

/**
 * Mark (or unmark) orders as test orders. The orders stay in the database
 * but every list, number, cash/profit figure and label queue ignores them.
 * Reversible at any time from the "test orders" filter.
 */
export async function setTestFlag(admin, orderId, isTest) {
  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: orderId },
    isTest
      ? { $set: { isTest: true, testMarkedAt: now, testMarkedBy: admin._id } }
      : { $set: { isTest: false, testMarkedAt: null, testMarkedBy: null } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw notFound('الطلب غير موجود');
  await recordEvent({
    order: updated._id,
    type: isTest ? 'order_marked_test' : 'order_unmarked_test',
    actor: userActor(admin),
    next: { isTest },
  });
  return updated;
}

/**
 * Apply one action to many orders. Each order goes through the same service
 * function (and the same checks) as the single-order action; failures are
 * reported per order and never stop the rest.
 */
export async function bulkAction(admin, { ids, action, courierId, reason, syncToEasyOrders }) {
  const unique = [...new Set(ids.map(String))];
  const done = [];
  const failed = [];
  for (const id of unique) {
    try {
      if (action === 'mark_test') await setTestFlag(admin, id, true);
      else if (action === 'unmark_test') await setTestFlag(admin, id, false);
      else if (action === 'assign') await assignOrder(admin, id, { courierId });
      else if (action === 'unassign') await assignOrder(admin, id, { courierId: null });
      else if (action === 'cancel') await adminChangeStatus(admin, id, { status: 'cancelled', reason, syncToEasyOrders: Boolean(syncToEasyOrders) });
      else if (action === 'reopen') await adminChangeStatus(admin, id, { status: 'new', reason });
      else if (action === 'hide') await hideOrder(admin, id);
      done.push(id);
    } catch (err) {
      failed.push({ id, message: err?.message || 'تعذر تنفيذ العملية' });
    }
  }
  return { done: done.length, failed };
}

async function hideOrder(admin, orderId) {
  const res = await Order.updateOne({ _id: orderId }, { $set: { dashboardHiddenAt: new Date(), dashboardHiddenBy: admin._id } });
  if (!res.matchedCount) throw notFound('الطلب غير موجود');
  await recordEvent({ order: orderId, type: 'order_hidden_from_dashboard', actor: userActor(admin) });
}

// ---------------------------------------------------------------- dashboard clear

/**
 * Clear every currently listed order from the admin dashboard. Nothing is
 * deleted: the orders only get a `dashboardHiddenAt` flag, which EasyOrders
 * webhooks and polling never touch, so they do not come back on their own.
 * Orders imported after this call are listed normally.
 */
export async function clearOrdersFromDashboard(admin) {
  const now = new Date();
  const res = await Order.updateMany(
    { dashboardHiddenAt: null },
    { $set: { dashboardHiddenAt: now, dashboardHiddenBy: admin._id } },
  );
  await recordEvent({
    type: 'orders_cleared_from_dashboard',
    actor: userActor(admin),
    next: { count: res.modifiedCount, at: now },
  });
  return { cleared: res.modifiedCount, at: now };
}

/** Undo: show every cleared order on the dashboard again. */
export async function restoreClearedOrders(admin) {
  const res = await Order.updateMany(
    { dashboardHiddenAt: { $ne: null } },
    { $set: { dashboardHiddenAt: null, dashboardHiddenBy: null } },
  );
  await recordEvent({
    type: 'orders_restored_to_dashboard',
    actor: userActor(admin),
    next: { count: res.modifiedCount },
  });
  return { restored: res.modifiedCount };
}

export async function countClearedOrders() {
  return Order.countDocuments({ dashboardHiddenAt: { $ne: null } });
}
