import mongoose from 'mongoose';
import { CashRemittance, Order, User } from '../models/index.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { sumMinor } from '../utils/money.js';
import { recordEvent, userActor } from './auditService.js';

/**
 * Cash-on-delivery reconciliation.
 *
 *  delivered (approved) COD order ──► included in a remittance
 *     declared   : courier declares cash handed over (or admin creates directly)
 *     received   : admin records the actual handed-over amount
 *     reconciled : admin verified amount == expected
 *     discrepancy: admin verified amount != expected
 *     cancelled  : voided before reconciliation; orders are released
 *
 * An order can belong to at most one non-cancelled remittance; this is
 * enforced with a conditional claim on order.cod.remittance.
 */

const ELIGIBLE = (courierId) => ({
  assignedTo: new mongoose.Types.ObjectId(String(courierId)),
  deliveryStatus: 'delivered',
  'cod.isCod': true,
  'cod.expectedAmount': { $gt: 0 },
  'cod.remittance': null,
});

export async function listEligibleOrders(courierId) {
  return Order.find(ELIGIBLE(courierId))
    .sort({ deliveredAt: 1 })
    .select('easyOrdersId easyOrdersShortId customer.name totalAmount cod deliveredAt isDemo')
    .lean();
}

async function loadCourier(courierId) {
  const courier = await User.findOne({ _id: courierId, role: 'courier' }).lean();
  if (!courier) throw notFound('المندوب غير موجود');
  return courier;
}

async function createRemittance({ courierId, orderIds, actor, declaredAmount = null, handedOverAmount = null, notes }) {
  await loadCourier(courierId);
  const ids = [...new Set(orderIds.map(String))];
  const orders = await Order.find({ ...ELIGIBLE(courierId), _id: { $in: ids } }).lean();
  if (orders.length !== ids.length) {
    throw unprocessable('بعض الطلبات المختارة غير مؤهلة أو مضافة لتسوية أخرى بالفعل', 'ORDERS_NOT_ELIGIBLE');
  }
  const expectedAmount = sumMinor(orders.map((o) => o.cod.expectedAmount));
  const now = new Date();
  const received = handedOverAmount !== null;

  const remittance = await CashRemittance.create({
    courier: courierId,
    orders: ids,
    expectedAmount,
    declaredAmount,
    handedOverAmount,
    difference: received ? handedOverAmount - expectedAmount : null,
    status: received ? 'received' : 'declared',
    createdBy: actor._id,
    receivedBy: received ? actor._id : null,
    receivedAt: received ? now : null,
    notes,
  });

  // Claim the orders atomically; roll back if any was claimed concurrently.
  const claim = await Order.updateMany(
    { ...ELIGIBLE(courierId), _id: { $in: ids } },
    { $set: { 'cod.remittance': remittance._id } },
  );
  if (claim.modifiedCount !== ids.length) {
    await Order.updateMany({ 'cod.remittance': remittance._id }, { $set: { 'cod.remittance': null } });
    await CashRemittance.deleteOne({ _id: remittance._id });
    throw conflict('تمت إضافة بعض الطلبات لتسوية أخرى في نفس الوقت. حدّث الصفحة وحاول مرة أخرى.', 'DUPLICATE_REMITTANCE');
  }

  await recordEvent({
    remittance: remittance._id,
    subjectUser: courierId,
    type: 'remittance_created',
    actor: userActor(actor),
    next: { status: remittance.status, expectedAmount, declaredAmount, handedOverAmount, orders: ids.length },
    reason: notes,
  });
  await Promise.all(
    ids.map((id) =>
      recordEvent({ order: id, type: 'remittance_linked', actor: userActor(actor), metadata: { remittance: remittance._id } }),
    ),
  );
  return remittance.toObject();
}

export function courierDeclareRemittance(courier, { orderIds, declaredAmount, notes }) {
  return createRemittance({ courierId: courier._id, orderIds, actor: courier, declaredAmount, notes });
}

export function adminCreateRemittance(admin, { courierId, orderIds, handedOverAmount, notes }) {
  return createRemittance({ courierId, orderIds, actor: admin, handedOverAmount, notes });
}

async function transition(remittanceId, fromStates, set, { admin, type, reason }) {
  const before = await CashRemittance.findById(remittanceId).lean();
  if (!before) throw notFound('سجل التسوية غير موجود');
  if (!fromStates.includes(before.status)) {
    throw unprocessable('لا يمكن تنفيذ هذا الإجراء على التسوية في حالتها الحالية', 'INVALID_TRANSITION');
  }
  const computed = typeof set === 'function' ? set(before) : set;
  const after = await CashRemittance.findOneAndUpdate(
    { _id: remittanceId, status: before.status, updatedAt: before.updatedAt },
    { $set: computed },
    { returnDocument: 'after' },
  ).lean();
  if (!after) throw conflict();
  await recordEvent({
    remittance: after._id,
    subjectUser: after.courier,
    type,
    actor: userActor(admin),
    previous: {
      status: before.status,
      handedOverAmount: before.handedOverAmount,
      verifiedAmount: before.verifiedAmount,
      difference: before.difference,
    },
    next: {
      status: after.status,
      handedOverAmount: after.handedOverAmount,
      verifiedAmount: after.verifiedAmount,
      difference: after.difference,
    },
    reason,
  });
  return after;
}

export function receiveRemittance(admin, id, { handedOverAmount, notes }) {
  return transition(
    id,
    ['declared'],
    (r) => ({
      status: 'received',
      handedOverAmount,
      difference: handedOverAmount - r.expectedAmount,
      receivedBy: admin._id,
      receivedAt: new Date(),
      ...(notes ? { notes } : {}),
    }),
    { admin, type: 'remittance_received', reason: notes },
  );
}

/** Verification (also used to correct a previous discrepancy; audited). */
export function verifyRemittance(admin, id, { verifiedAmount, notes }) {
  return transition(
    id,
    ['received', 'discrepancy'],
    (r) => ({
      status: verifiedAmount === r.expectedAmount ? 'reconciled' : 'discrepancy',
      verifiedAmount,
      difference: verifiedAmount - r.expectedAmount,
      verifiedBy: admin._id,
      reconciledAt: new Date(),
      ...(notes ? { notes } : {}),
    }),
    { admin, type: 'remittance_verified', reason: notes },
  );
}

export async function cancelRemittance(admin, id, { reason }) {
  const after = await transition(
    id,
    ['declared', 'received'],
    { status: 'cancelled', cancelledBy: admin._id, cancelledAt: new Date() },
    { admin, type: 'remittance_cancelled', reason },
  );
  await Order.updateMany({ 'cod.remittance': after._id }, { $set: { 'cod.remittance': null } });
  await Promise.all(
    after.orders.map((orderId) =>
      recordEvent({ order: orderId, type: 'remittance_released', actor: userActor(admin), reason, metadata: { remittance: after._id } }),
    ),
  );
  return after;
}

export async function listRemittances({ status, courier }, { skip, limit }) {
  const query = {};
  if (status) query.status = status;
  if (courier) query.courier = courier;
  const [items, total] = await Promise.all([
    CashRemittance.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('courier', 'name phone')
      .populate('createdBy receivedBy verifiedBy', 'name role')
      .lean(),
    CashRemittance.countDocuments(query),
  ]);
  return { items, total };
}

export async function getRemittance(id, { courierId } = {}) {
  const query = { _id: id };
  if (courierId) query.courier = courierId;
  const remittance = await CashRemittance.findOne(query)
    .populate('courier', 'name phone')
    .populate('createdBy receivedBy verifiedBy cancelledBy', 'name role')
    .populate('orders', 'easyOrdersId easyOrdersShortId customer.name totalAmount cod.expectedAmount cod.declaredAmount deliveredAt')
    .lean();
  if (!remittance) throw notFound('سجل التسوية غير موجود');
  return remittance;
}

/** Per-courier cash position. */
export async function courierCashSummary(courierId) {
  const cid = new mongoose.Types.ObjectId(String(courierId));
  const [unremitted, inProgress, remittanceTotals] = await Promise.all([
    Order.aggregate([
      { $match: ELIGIBLE(cid) },
      { $group: { _id: null, expected: { $sum: '$cod.expectedAmount' }, declared: { $sum: { $ifNull: ['$cod.declaredAmount', 0] } }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { assignedTo: cid, 'cod.isCod': true, deliveryStatus: { $in: ['out_for_delivery', 'pending_delivery_review'] } } },
      { $group: { _id: null, expected: { $sum: '$cod.expectedAmount' }, count: { $sum: 1 } } },
    ]),
    CashRemittance.aggregate([
      { $match: { courier: cid, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$status',
          expected: { $sum: '$expectedAmount' },
          handedOver: { $sum: { $ifNull: ['$handedOverAmount', 0] } },
          verified: { $sum: { $ifNull: ['$verifiedAmount', 0] } },
          difference: { $sum: { $ifNull: ['$difference', 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  const byStatus = Object.fromEntries(remittanceTotals.map((r) => [r._id, r]));
  const pick = (s, f) => byStatus[s]?.[f] || 0;
  const awaitingVerification = pick('declared', 'expected') + pick('received', 'expected');
  return {
    unremittedExpected: unremitted[0]?.expected || 0,
    unremittedDeclared: unremitted[0]?.declared || 0,
    unremittedCount: unremitted[0]?.count || 0,
    inTransitExpected: inProgress[0]?.expected || 0,
    inTransitCount: inProgress[0]?.count || 0,
    awaitingVerification,
    handedOver: pick('received', 'handedOver') + pick('reconciled', 'handedOver') + pick('discrepancy', 'handedOver'),
    verified: pick('reconciled', 'verified') + pick('discrepancy', 'verified'),
    discrepancy: pick('discrepancy', 'difference'),
    outstanding: (unremitted[0]?.expected || 0) + awaitingVerification,
  };
}

/** Totals for all couriers (admin overview / cash page). */
export async function cashOverview() {
  const [expected, unremitted, remittances, perCourier] = await Promise.all([
    Order.aggregate([
      { $match: { deliveryStatus: 'delivered', 'cod.isCod': true } },
      { $group: { _id: null, total: { $sum: '$cod.expectedAmount' } } },
    ]),
    Order.aggregate([
      { $match: { deliveryStatus: 'delivered', 'cod.isCod': true, 'cod.remittance': null } },
      { $group: { _id: null, total: { $sum: '$cod.expectedAmount' } } },
    ]),
    CashRemittance.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$status',
          expected: { $sum: '$expectedAmount' },
          declared: { $sum: { $ifNull: ['$declaredAmount', 0] } },
          handedOver: { $sum: { $ifNull: ['$handedOverAmount', 0] } },
          verified: { $sum: { $ifNull: ['$verifiedAmount', 0] } },
          difference: { $sum: { $ifNull: ['$difference', 0] } },
        },
      },
    ]),
    Order.aggregate([
      { $match: { deliveryStatus: 'delivered', 'cod.isCod': true, 'cod.remittance': null, assignedTo: { $ne: null } } },
      { $group: { _id: '$assignedTo', expected: { $sum: '$cod.expectedAmount' }, count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'courier' } },
      { $unwind: '$courier' },
      { $project: { expected: 1, count: 1, 'courier._id': 1, 'courier.name': 1, 'courier.phone': 1 } },
      { $sort: { expected: -1 } },
    ]),
  ]);
  const byStatus = Object.fromEntries(remittances.map((r) => [r._id, r]));
  const sumOf = (field, statuses) => statuses.reduce((acc, s) => acc + (byStatus[s]?.[field] || 0), 0);
  const awaitingVerification = sumOf('expected', ['declared', 'received']);
  return {
    expectedDelivered: expected[0]?.total || 0,
    unremitted: unremitted[0]?.total || 0,
    declared: sumOf('declared', ['declared', 'received', 'reconciled', 'discrepancy']),
    handedOver: sumOf('handedOver', ['received', 'reconciled', 'discrepancy']),
    verified: sumOf('verified', ['reconciled', 'discrepancy']),
    discrepancy: sumOf('difference', ['discrepancy']),
    awaitingVerification,
    outstanding: (unremitted[0]?.total || 0) + awaitingVerification,
    perCourier,
  };
}
