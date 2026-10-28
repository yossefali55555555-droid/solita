import { paginated, paginationParams } from '../utils/pagination.js';
import { listOrderEvents, userActor } from '../services/auditService.js';
import * as couriers from '../services/courierService.js';
import * as orders from '../services/orderService.js';
import * as delivery from '../services/deliveryService.js';
import * as sync from '../services/syncService.js';
import * as webhooks from '../services/webhookService.js';
import * as cash from '../services/cashService.js';
import * as poll from '../services/pollService.js';
import { getOverview, getSystemStatus } from '../services/statsService.js';
import { processBackgroundWork } from '../jobs/processBackgroundWork.js';
import { notFound } from '../utils/errors.js';
import { OrderEvent } from '../models/index.js';

// ---------- Overview ----------
export async function overview(_req, res) {
  res.json({ stats: await getOverview(), system: getSystemStatus() });
}

// ---------- Couriers ----------
export async function createCourier(req, res) {
  res.status(201).json({ courier: await couriers.createCourier(req.user, req.valid.body) });
}

export async function listCouriers(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await couriers.listCouriers(req.valid.query, page);
  res.json(paginated(items, total, page));
}

export async function listCouriersBrief(_req, res) {
  res.json({ items: await couriers.listCouriersBrief() });
}

export async function getCourier(req, res) {
  res.json(await couriers.getCourierDetail(req.valid.params.id));
}

export async function updateCourier(req, res) {
  res.json({ courier: await couriers.updateCourier(req.user, req.valid.params.id, req.valid.body) });
}

export async function setCourierActive(req, res) {
  res.json(await couriers.setCourierActive(req.user, req.valid.params.id, req.valid.body.isActive));
}

export async function resetCourierPassword(req, res) {
  res.json({ courier: await couriers.resetCourierPassword(req.user, req.valid.params.id, req.valid.body.newPassword) });
}

export async function courierEvents(req, res) {
  const items = await OrderEvent.find({ subjectUser: req.valid.params.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items });
}

// ---------- Orders ----------
export async function listOrders(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await orders.listOrders(req.valid.query, page);
  res.json(paginated(items, total, page));
}

export async function getOrder(req, res) {
  res.json(await orders.getOrderForAdmin(req.valid.params.id));
}

export async function assignOrder(req, res) {
  res.json({ order: await orders.assignOrder(req.user, req.valid.params.id, req.valid.body) });
}

export async function changeOrderStatus(req, res) {
  res.json(await orders.adminChangeStatus(req.user, req.valid.params.id, req.valid.body));
}

export async function acknowledgeConflict(req, res) {
  res.json({ order: await orders.clearSourceConflict(req.user, req.valid.params.id) });
}

export async function orderEvents(req, res) {
  res.json({ items: await listOrderEvents(req.valid.params.id) });
}

// ---------- Delivery reviews ----------
export async function listReviews(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await delivery.listReviews(req.valid.query, page);
  res.json(paginated(items, total, page));
}

export async function getReview(req, res) {
  res.json(await delivery.getReview(req.valid.params.id));
}

export async function approveReview(req, res) {
  res.json(await delivery.approveReview(req.user, req.valid.params.id));
}

export async function rejectReview(req, res) {
  res.json(await delivery.rejectReview(req.user, req.valid.params.id, req.valid.body));
}

// ---------- Synchronization ----------
export async function syncFailures(req, res) {
  const page = paginationParams(req.valid.query);
  const [{ items, total }, webhookItems] = await Promise.all([
    sync.listSyncProblems(page),
    webhooks.listWebhookProblems({ limit: 50 }),
  ]);
  res.json({ ...paginated(items, total, page), webhooks: webhookItems });
}

export async function retrySync(req, res) {
  res.json({ operation: await sync.retryOperation(req.valid.params.id, req.user) });
}

export async function retryWebhook(req, res) {
  const event = await webhooks.retryWebhookEvent(req.valid.params.id);
  if (!event) throw notFound('لا يوجد حدث فاشل بهذا المعرّف');
  res.json({ event });
}

export async function pollStatus(_req, res) {
  res.json(await poll.getPollStatus());
}

export async function pollNow(_req, res) {
  res.json({ result: await poll.pollEasyOrders(), status: await poll.getPollStatus() });
}

export async function importEasyOrdersOrder(req, res) {
  const { order, outcome } = await poll.importOrder(req.valid.body, userActor(req.user));
  res.status(outcome === 'created' ? 201 : 200).json({ order, outcome });
}

export async function processDue(_req, res) {
  res.json(await processBackgroundWork({ timeBudgetMs: 20_000 }));
}

// ---------- Cash ----------
export async function cashOverview(_req, res) {
  res.json(await cash.cashOverview());
}

export async function eligibleOrders(req, res) {
  res.json({ items: await cash.listEligibleOrders(req.valid.query.courier) });
}

export async function listRemittances(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await cash.listRemittances(req.valid.query, page);
  res.json(paginated(items, total, page));
}

export async function getRemittance(req, res) {
  res.json({ remittance: await cash.getRemittance(req.valid.params.id) });
}

export async function createRemittance(req, res) {
  res.status(201).json({ remittance: await cash.adminCreateRemittance(req.user, req.valid.body) });
}

export async function receiveRemittance(req, res) {
  res.json({ remittance: await cash.receiveRemittance(req.user, req.valid.params.id, req.valid.body) });
}

export async function verifyRemittance(req, res) {
  res.json({ remittance: await cash.verifyRemittance(req.user, req.valid.params.id, req.valid.body) });
}

export async function cancelRemittance(req, res) {
  res.json({ remittance: await cash.cancelRemittance(req.user, req.valid.params.id, req.valid.body) });
}

export async function remittanceEvents(req, res) {
  const items = await OrderEvent.find({ remittance: req.valid.params.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items });
}
