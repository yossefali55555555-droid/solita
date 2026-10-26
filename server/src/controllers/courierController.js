import { paginated, paginationParams } from '../utils/pagination.js';
import * as delivery from '../services/deliveryService.js';
import * as cash from '../services/cashService.js';

// All handlers use req.user (from the session) as the courier identity.

export async function listOrders(req, res) {
  const page = paginationParams({ limit: 50, ...req.valid.query });
  const { items, total, counts } = await delivery.listCourierOrders(req.user, { scope: req.valid.query.scope, ...page });
  res.json({ ...paginated(items, total, page), counts });
}

export async function getOrder(req, res) {
  res.json(await delivery.getCourierOrder(req.user, req.valid.params.id));
}

export async function updateStatus(req, res) {
  const { status, reason, note } = req.valid.body;
  if (status === 'out_for_delivery') {
    return res.json(await delivery.startDelivery(req.user, req.valid.params.id));
  }
  res.json(await delivery.reportFailedAttempt(req.user, req.valid.params.id, { reason, note }));
}

export async function deliveryReport(req, res) {
  res.status(201).json(await delivery.submitDeliveryReport(req.user, req.valid.params.id, req.valid.body));
}

export async function cashSummary(req, res) {
  const [summary, eligible, remittances] = await Promise.all([
    cash.courierCashSummary(req.user._id),
    cash.listEligibleOrders(req.user._id),
    cash.listRemittances({ courier: req.user._id }, { skip: 0, limit: 50 }),
  ]);
  res.json({ summary, eligibleOrders: eligible, remittances: remittances.items });
}

export async function declareRemittance(req, res) {
  res.status(201).json({ remittance: await cash.courierDeclareRemittance(req.user, req.valid.body) });
}

export async function getRemittance(req, res) {
  res.json({ remittance: await cash.getRemittance(req.valid.params.id, { courierId: req.user._id }) });
}
