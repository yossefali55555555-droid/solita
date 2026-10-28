import mongoose from 'mongoose';
import { DeliveryReview, Order, User, publicUser } from '../models/index.js';
import { conflict, isDuplicateKeyError, notFound } from '../utils/errors.js';
import { escapeRegex } from '../utils/sanitize.js';
import { hashPassword } from './passwordService.js';
import { revokeAllSessions } from './authService.js';
import { recordEvent, userActor } from './auditService.js';
import { courierCashSummary } from './cashService.js';

/**
 * Courier account management (admin only). Only users with role "courier"
 * can be read or changed through these functions; roles are never accepted
 * from input, so a courier can never be promoted here.
 */

async function findCourier(id) {
  const courier = await User.findOne({ _id: id, role: 'courier' });
  if (!courier) throw notFound('المندوب غير موجود');
  return courier;
}

function duplicateMessage(err) {
  return err?.keyPattern?.email ? 'البريد الإلكتروني مستخدم بالفعل' : 'رقم الهاتف مستخدم بالفعل';
}

export async function createCourier(admin, { name, phone, email, password }) {
  try {
    const courier = await User.create({
      name,
      phone,
      email,
      passwordHash: await hashPassword(password),
      role: 'courier',
      isActive: true,
      mustChangePassword: true,
    });
    await recordEvent({ subjectUser: courier._id, type: 'courier_created', actor: userActor(admin), next: { name, phone } });
    return publicUser(courier);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict(duplicateMessage(err), 'DUPLICATE_USER');
    throw err;
  }
}

export async function listCouriers({ q, active }, { skip, limit }) {
  const query = { role: 'courier' };
  if (active) query.isActive = active === 'true';
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    query.$or = [{ name: rx }, { phone: rx }, { email: rx }];
  }
  const [users, total] = await Promise.all([
    User.find(query).sort({ isActive: -1, name: 1 }).skip(skip).limit(limit),
    User.countDocuments(query),
  ]);
  const ids = users.map((u) => u._id);
  const counts = await Order.aggregate([
    { $match: { assignedTo: { $in: ids } } },
    { $group: { _id: { courier: '$assignedTo', status: '$deliveryStatus' }, n: { $sum: 1 } } },
  ]);
  const stats = {};
  for (const c of counts) {
    const key = String(c._id.courier);
    stats[key] ||= {};
    stats[key][c._id.status] = c.n;
  }
  const items = users.map((u) => {
    const s = stats[String(u._id)] || {};
    return {
      ...publicUser(u),
      workload: {
        assigned: s.assigned || 0,
        outForDelivery: s.out_for_delivery || 0,
        pendingReview: s.pending_delivery_review || 0,
        failed: s.failed || 0,
        delivered: s.delivered || 0,
      },
    };
  });
  return { items, total };
}

export async function getCourierDetail(id) {
  const courier = await findCourier(id);
  const cid = new mongoose.Types.ObjectId(String(id));
  const [activeOrders, recentReviews, cash] = await Promise.all([
    Order.find({ assignedTo: cid, deliveryStatus: { $in: ['assigned', 'out_for_delivery', 'pending_delivery_review', 'failed'] } })
      .sort({ assignedAt: 1 })
      .select('easyOrdersId easyOrdersShortId customer.name customer.government totalAmount deliveryStatus sourceStatus assignedAt')
      .limit(200)
      .lean(),
    DeliveryReview.find({ courier: cid })
      .sort({ submittedAt: -1 })
      .limit(50)
      .populate('order', 'easyOrdersId easyOrdersShortId customer.name totalAmount')
      .populate('reviewer', 'name')
      .lean(),
    courierCashSummary(cid),
  ]);
  return { courier: publicUser(courier), activeOrders, recentReviews, cash };
}

export async function updateCourier(admin, id, changes) {
  const courier = await findCourier(id);
  const previous = { name: courier.name, phone: courier.phone, email: courier.email || null };
  if (changes.name !== undefined) courier.name = changes.name;
  if (changes.phone !== undefined) courier.phone = changes.phone;
  if (changes.email !== undefined) courier.email = changes.email || undefined;
  try {
    await courier.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict(duplicateMessage(err), 'DUPLICATE_USER');
    throw err;
  }
  await recordEvent({
    subjectUser: courier._id,
    type: 'courier_updated',
    actor: userActor(admin),
    previous,
    next: { name: courier.name, phone: courier.phone, email: courier.email || null },
  });
  return publicUser(courier);
}

export async function setCourierActive(admin, id, isActive) {
  const courier = await findCourier(id);
  if (courier.isActive === isActive) return { courier: publicUser(courier), openOrders: 0 };
  courier.isActive = isActive;
  await courier.save();
  if (!isActive) await revokeAllSessions(courier._id);
  const openOrders = await Order.countDocuments({
    assignedTo: courier._id,
    deliveryStatus: { $in: ['assigned', 'out_for_delivery', 'failed'] },
  });
  await recordEvent({
    subjectUser: courier._id,
    type: isActive ? 'courier_activated' : 'courier_deactivated',
    actor: userActor(admin),
    previous: { isActive: !isActive },
    next: { isActive },
    metadata: { openOrders },
  });
  return { courier: publicUser(courier), openOrders };
}

/** Admin sets a temporary password; the courier must change it at next login. */
export async function resetCourierPassword(admin, id, newPassword) {
  const courier = await findCourier(id);
  courier.passwordHash = await hashPassword(newPassword);
  courier.mustChangePassword = true;
  courier.passwordChangedAt = new Date();
  await courier.save();
  await revokeAllSessions(courier._id);
  await recordEvent({ subjectUser: courier._id, type: 'courier_password_reset', actor: userActor(admin) });
  return publicUser(courier);
}

/** Compact list for selects (active couriers first; inactive ones still matter for cash records). */
export async function listCouriersBrief() {
  const users = await User.find({ role: 'courier' }).sort({ isActive: -1, name: 1 }).select('name phone isActive').lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, phone: u.phone, isActive: u.isActive }));
}
