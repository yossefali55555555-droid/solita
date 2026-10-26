import { DeliveryReview, Order, SyncOperation, WebhookEvent } from '../models/index.js';
import { getConfig } from '../config/env.js';
import { cashOverview } from './cashService.js';

/** Real, database-backed overview numbers (no hardcoded statistics). */
export async function getOverview() {
  const [byDelivery, unassigned, pendingReviews, syncFailures, webhookFailures, total, cash] = await Promise.all([
    Order.aggregate([{ $group: { _id: '$deliveryStatus', n: { $sum: 1 } } }]),
    Order.countDocuments({ assignedTo: null, deliveryStatus: { $in: ['new', 'failed'] } }),
    DeliveryReview.countDocuments({ status: 'pending' }),
    SyncOperation.countDocuments({ state: { $in: ['failed', 'needs_reconciliation'] } }),
    WebhookEvent.countDocuments({ status: { $in: ['failed', 'pending_retry'] } }),
    Order.estimatedDocumentCount(),
    cashOverview(),
  ]);
  const d = Object.fromEntries(byDelivery.map((x) => [x._id, x.n]));
  return {
    orders: {
      total,
      new: d.new || 0,
      unassigned,
      assigned: d.assigned || 0,
      outForDelivery: d.out_for_delivery || 0,
      pendingReview: d.pending_delivery_review || 0,
      delivered: d.delivered || 0,
      failed: d.failed || 0,
      cancelled: d.cancelled || 0,
    },
    pendingReviews,
    sync: { failures: syncFailures, webhookFailures },
    cash: {
      expected: cash.expectedDelivered,
      handedOver: cash.handedOver,
      verified: cash.verified,
      outstanding: cash.outstanding,
      discrepancy: cash.discrepancy,
    },
  };
}

/** Integration readiness (admin only; never exposes secret values). */
export function getSystemStatus() {
  const config = getConfig();
  return {
    mockMode: config.mockMode,
    environment: config.isProduction ? 'production' : config.nodeEnv,
    easyOrders: {
      apiConfigured: config.easyOrders.apiConfigured,
      webhooksConfigured: config.easyOrders.webhooksConfigured,
      baseUrl: config.easyOrders.baseUrl,
    },
    cronConfigured: Boolean(config.cronSecret),
    sessionSecretEphemeral: config.sessionSecretIsEphemeral,
  };
}
