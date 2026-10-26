import { DeliveryReview, Order } from '../models/index.js';
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound, unprocessable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { recordEvent, userActor } from './auditService.js';
import { notify } from './notificationService.js';
import { enqueueStatusSync, processOperation } from './syncService.js';

/**
 * Courier delivery workflow and mandatory supervisor approval.
 *
 * Ownership is enforced in every query: a courier can only act on orders
 * whose assignedTo is their own user id (taken from the session, never
 * from the request). Orders of other couriers respond 404.
 */

// Source statuses after which pushing `in_delivery` makes no sense.
const NO_IN_DELIVERY_PUSH = ['in_delivery', 'delivered', 'canceled', 'refunded', 'refund_in_progress', 'request_refund', 'returning_from_delivery'];

const COURIER_ORDER_FIELDS = [
  'easyOrdersId',
  'customer',
  'items',
  'subtotal',
  'shippingFee',
  'discount',
  'totalAmount',
  'currency',
  'paymentMethod',
  'paymentStatus',
  'sourceStatus',
  'deliveryStatus',
  'assignedAt',
  'deliveryAttempts',
  'currentReview',
  'deliveredAt',
  'cod',
  'cancellation.reason',
  'isDemo',
  'createdAt',
  'sourceCreatedAt',
].join(' ');

async function findOwnedOrder(courier, orderId) {
  const order = await Order.findOne({ _id: orderId, assignedTo: courier._id }).lean();
  if (!order) throw notFound('الطلب غير موجود');
  return order;
}

// ---------------------------------------------------------------- courier reads

const SCOPES = {
  active: ['assigned', 'out_for_delivery', 'failed'],
  review: ['pending_delivery_review'],
  completed: ['delivered', 'cancelled'],
};

export async function listCourierOrders(courier, { scope = 'active', skip = 0, limit = 50 }) {
  const query = { assignedTo: courier._id };
  if (SCOPES[scope]) query.deliveryStatus = { $in: SCOPES[scope] };
  const [items, total, counts] = await Promise.all([
    Order.find(query)
      .sort(scope === 'completed' ? { updatedAt: -1 } : { assignedAt: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select(COURIER_ORDER_FIELDS)
      .lean(),
    Order.countDocuments(query),
    Order.aggregate([{ $match: { assignedTo: courier._id } }, { $group: { _id: '$deliveryStatus', n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  const sum = (list) => list.reduce((acc, s) => acc + (byStatus[s] || 0), 0);
  return {
    items,
    total,
    counts: { active: sum(SCOPES.active), review: sum(SCOPES.review), completed: sum(SCOPES.completed) },
  };
}

export async function getCourierOrder(courier, orderId) {
  const order = await Order.findOne({ _id: orderId, assignedTo: courier._id }).select(COURIER_ORDER_FIELDS).lean();
  if (!order) throw notFound('الطلب غير موجود');
  // Only this courier's own reports are visible to them.
  const reviews = await DeliveryReview.find({ order: orderId, courier: courier._id })
    .sort({ submittedAt: -1 })
    .select('status submittedAt reviewedAt rejectionReason courierNote collectedAmount submissionNumber')
    .lean();
  const attempts = (order.deliveryAttempts || []).filter((a) => String(a.courier) === String(courier._id));
  return { order: { ...order, deliveryAttempts: attempts }, reviews, allowedActions: allowedCourierActions(order) };
}

export function allowedCourierActions(order) {
  switch (order.deliveryStatus) {
    case 'assigned':
      return ['start_delivery', 'report_failed'];
    case 'out_for_delivery':
      return ['submit_delivery', 'report_failed'];
    case 'failed':
      return ['start_delivery'];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- courier actions

export async function startDelivery(courier, orderId) {
  const order = await findOwnedOrder(courier, orderId);
  if (!['assigned', 'failed'].includes(order.deliveryStatus)) {
    throw unprocessable('لا يمكن بدء التوصيل في حالة الطلب الحالية', 'INVALID_TRANSITION');
  }
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: courier._id, deliveryStatus: order.deliveryStatus },
    { $set: { deliveryStatus: 'out_for_delivery' } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict();

  await recordEvent({
    order: order._id,
    type: 'delivery_started',
    actor: userActor(courier),
    previous: { deliveryStatus: order.deliveryStatus },
    next: { deliveryStatus: 'out_for_delivery' },
  });

  // Synchronize `in_delivery` through the documented status API. A sync
  // failure never blocks the courier; it is visible to administrators.
  let syncOperation = null;
  if (!NO_IN_DELIVERY_PUSH.includes(order.sourceStatus)) {
    try {
      const attemptNo = (order.deliveryAttempts?.length || 0) + 1;
      const op = await enqueueStatusSync({
        order,
        targetStatus: 'in_delivery',
        trigger: 'delivery_started',
        requestedBy: courier,
        idempotencyKey: `in_delivery:${order._id}:${attemptNo}`,
      });
      syncOperation = await processOperation(op._id);
    } catch (err) {
      logger.warn('Could not start in_delivery sync', { order: String(order._id), error: err.message });
    }
  }
  return { order: updated, syncState: syncOperation?.state ?? null };
}

export async function reportFailedAttempt(courier, orderId, { reason, note }) {
  const order = await findOwnedOrder(courier, orderId);
  if (!['assigned', 'out_for_delivery'].includes(order.deliveryStatus)) {
    throw unprocessable('لا يمكن تسجيل محاولة فاشلة في حالة الطلب الحالية', 'INVALID_TRANSITION');
  }
  const attempt = { courier: courier._id, outcome: 'failed', reason, note, at: new Date() };
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: courier._id, deliveryStatus: order.deliveryStatus },
    { $set: { deliveryStatus: 'failed' }, $push: { deliveryAttempts: attempt } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict();
  // A failed attempt never cancels the order in EasyOrders.
  await recordEvent({
    order: order._id,
    type: 'delivery_failed',
    actor: userActor(courier),
    previous: { deliveryStatus: order.deliveryStatus },
    next: { deliveryStatus: 'failed' },
    reason: note || reason,
    metadata: { reason },
  });
  return { order: updated };
}

/**
 * Courier presses "تم التسليم": creates a pending review. EasyOrders is NOT
 * updated here; that happens only after supervisor approval.
 */
export async function submitDeliveryReport(courier, orderId, { collectedAmount, note, proofReference }) {
  const order = await findOwnedOrder(courier, orderId);
  if (order.deliveryStatus !== 'out_for_delivery') {
    throw unprocessable('يجب بدء التوصيل قبل إرسال تأكيد التسليم', 'INVALID_TRANSITION');
  }
  const expected = order.cod?.isCod ? order.cod.expectedAmount || 0 : 0;
  if (expected > 0 && (collectedAmount === undefined || collectedAmount === null)) {
    throw badRequest('أدخل المبلغ الذي تم تحصيله من العميل', 'COLLECTED_AMOUNT_REQUIRED');
  }

  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, assignedTo: courier._id, deliveryStatus: 'out_for_delivery' },
    { $set: { deliveryStatus: 'pending_delivery_review' } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw conflict();

  let review;
  try {
    const previousCount = await DeliveryReview.countDocuments({ order: orderId });
    review = await DeliveryReview.create({
      order: orderId,
      courier: courier._id,
      submittedAt: now,
      courierNote: note,
      proofReference,
      collectedAmount: expected > 0 ? collectedAmount : (collectedAmount ?? null),
      expectedAmount: expected,
      sourceStatusAtSubmission: order.sourceStatus,
      submissionNumber: previousCount + 1,
    });
  } catch (err) {
    // Roll back the claim so the courier can try again.
    await Order.updateOne(
      { _id: orderId, deliveryStatus: 'pending_delivery_review' },
      { $set: { deliveryStatus: 'out_for_delivery' } },
    );
    if (isDuplicateKeyError(err)) throw conflict('تم إرسال تقرير التسليم بالفعل وهو بانتظار المراجعة', 'REVIEW_ALREADY_PENDING');
    throw err;
  }

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        currentReview: review._id,
        'cod.declaredAmount': review.collectedAmount,
        'cod.declaredAt': now,
        'cod.declaredBy': courier._id,
      },
    },
  );
  await recordEvent({
    order: order._id,
    type: 'delivery_submitted',
    actor: userActor(courier),
    previous: { deliveryStatus: 'out_for_delivery' },
    next: { deliveryStatus: 'pending_delivery_review' },
    metadata: { review: review._id, collectedAmount: review.collectedAmount, expectedAmount: expected, proofReference },
  });
  return { review, message: 'تم إرسال الطلب للمراجعة' };
}

// ---------------------------------------------------------------- supervisor review

export async function listReviews({ status, courier }, { skip, limit }) {
  const query = {};
  if (status) query.status = status;
  if (courier) query.courier = courier;
  const [items, total] = await Promise.all([
    DeliveryReview.find(query)
      .sort(status === 'pending' ? { submittedAt: 1 } : { submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('courier', 'name phone')
      .populate('reviewer', 'name')
      .populate('order', 'easyOrdersId customer totalAmount currency paymentMethod sourceStatus deliveryStatus cod sourceConflict isDemo')
      .lean(),
    DeliveryReview.countDocuments(query),
  ]);
  return { items, total };
}

export async function getReview(reviewId) {
  const review = await DeliveryReview.findById(reviewId)
    .populate('courier', 'name phone')
    .populate('reviewer', 'name')
    .populate('syncOperation')
    .lean();
  if (!review) throw notFound('تقرير التسليم غير موجود');
  const [order, history] = await Promise.all([
    Order.findById(review.order).populate('assignedTo', 'name phone').lean(),
    DeliveryReview.find({ order: review.order })
      .sort({ submittedAt: -1 })
      .populate('courier', 'name')
      .populate('reviewer', 'name')
      .lean(),
  ]);
  return { review, order, history };
}

function assertNotSelfReview(admin, review) {
  if (String(review.courier) === String(admin._id)) {
    throw forbidden('لا يمكن مراجعة تقرير تسليم قدمته بنفسك', 'SELF_REVIEW_FORBIDDEN');
  }
}

export async function approveReview(admin, reviewId) {
  const review = await DeliveryReview.findById(reviewId).lean();
  if (!review) throw notFound('تقرير التسليم غير موجود');
  assertNotSelfReview(admin, review);
  if (review.status !== 'pending') throw conflict('تمت مراجعة هذا التقرير بالفعل', 'ALREADY_REVIEWED');

  const now = new Date();
  // Atomic claim: only one reviewer can move the review out of `pending`.
  const claimed = await DeliveryReview.findOneAndUpdate(
    { _id: reviewId, status: 'pending', courier: { $ne: admin._id } },
    { $set: { status: 'approved', reviewer: admin._id, reviewedAt: now, syncStatus: 'pending' } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw conflict('تمت مراجعة هذا التقرير بالفعل', 'ALREADY_REVIEWED');

  const order = await Order.findOneAndUpdate(
    { _id: review.order, deliveryStatus: 'pending_delivery_review', currentReview: review._id },
    { $set: { deliveryStatus: 'delivered', deliveredAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!order) {
    // The order changed underneath us; undo the claim so nothing is half-done.
    await DeliveryReview.updateOne(
      { _id: reviewId, status: 'approved', reviewer: admin._id },
      { $set: { status: 'pending', reviewer: null, reviewedAt: null, syncStatus: 'not_started' } },
    );
    throw conflict('تغيرت حالة الطلب، حدّث الصفحة وحاول مرة أخرى');
  }

  await recordEvent({
    order: order._id,
    type: 'review_approved',
    actor: userActor(admin),
    previous: { deliveryStatus: 'pending_delivery_review', reviewStatus: 'pending' },
    next: { deliveryStatus: 'delivered', reviewStatus: 'approved' },
    metadata: { review: review._id, courier: review.courier },
  });
  await notify(review.courier, 'review_approved', `تمت الموافقة على تسليم الطلب (${order.easyOrdersId})`, order._id);

  // Start EasyOrders synchronization; tracked independently of the approval.
  let syncOperation = null;
  if (order.sourceStatus === 'delivered') {
    await DeliveryReview.updateOne({ _id: reviewId }, { $set: { syncStatus: 'synced' } });
  } else {
    const op = await enqueueStatusSync({
      order,
      targetStatus: 'delivered',
      trigger: 'delivery_approved',
      review: claimed,
      requestedBy: admin,
      idempotencyKey: `delivered:${review._id}`,
    });
    await DeliveryReview.updateOne({ _id: reviewId }, { $set: { syncOperation: op._id } });
    syncOperation = await processOperation(op._id);
  }

  return {
    review: await DeliveryReview.findById(reviewId).lean(),
    order: await Order.findById(order._id).lean(),
    syncOperation,
  };
}

export async function rejectReview(admin, reviewId, { reason }) {
  if (!reason || reason.trim().length < 3) throw badRequest('سبب الرفض مطلوب', 'REASON_REQUIRED');
  const review = await DeliveryReview.findById(reviewId).lean();
  if (!review) throw notFound('تقرير التسليم غير موجود');
  assertNotSelfReview(admin, review);
  if (review.status !== 'pending') throw conflict('تمت مراجعة هذا التقرير بالفعل', 'ALREADY_REVIEWED');

  const now = new Date();
  const claimed = await DeliveryReview.findOneAndUpdate(
    { _id: reviewId, status: 'pending', courier: { $ne: admin._id } },
    { $set: { status: 'rejected', reviewer: admin._id, reviewedAt: now, rejectionReason: reason.trim() } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw conflict('تمت مراجعة هذا التقرير بالفعل', 'ALREADY_REVIEWED');

  // Back to the courier for follow-up: resubmit or report a failed attempt.
  const order = await Order.findOneAndUpdate(
    { _id: review.order, deliveryStatus: 'pending_delivery_review' },
    {
      $set: { deliveryStatus: 'out_for_delivery', currentReview: null },
      $unset: { 'cod.declaredAmount': 1, 'cod.declaredAt': 1, 'cod.declaredBy': 1 },
    },
    { returnDocument: 'after' },
  ).lean();

  await recordEvent({
    order: review.order,
    type: 'review_rejected',
    actor: userActor(admin),
    previous: { deliveryStatus: 'pending_delivery_review', reviewStatus: 'pending' },
    next: { deliveryStatus: order?.deliveryStatus ?? null, reviewStatus: 'rejected' },
    reason: reason.trim(),
    metadata: { review: review._id, courier: review.courier },
  });
  await notify(
    review.courier,
    'review_rejected',
    `تم رفض تأكيد تسليم الطلب (${order?.easyOrdersId ?? ''}): ${reason.trim()}`,
    review.order,
  );
  return { review: claimed, order };
}
