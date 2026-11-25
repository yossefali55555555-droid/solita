import { DeliveryReview, Order, SyncOperation, WebhookEvent } from '../models/index.js';
import { NOT_TEST } from '../models/Order.js';
import { getConfig } from '../config/env.js';
import { cashOverview } from './cashService.js';
import { FULL_VIEWER } from './visibilityService.js';

// Orders cleared from the dashboard are left out of the overview counts.
const VISIBLE = { dashboardHiddenAt: null, ...NOT_TEST };

/**
 * Real, database-backed overview numbers (no hardcoded statistics). Each block
 * is only computed for a viewer who has the permission of its section.
 */
export async function getOverview(viewer = FULL_VIEWER) {
  const none = Promise.resolve(null);
  const [byDelivery, unassigned, pendingReviews, syncFailures, webhookFailures, total, cash] = await Promise.all([
    viewer.can('orders') ? Order.aggregate([{ $match: VISIBLE }, { $group: { _id: '$deliveryStatus', n: { $sum: 1 } } }]) : none,
    viewer.can('orders') ? Order.countDocuments({ ...VISIBLE, assignedTo: null, deliveryStatus: { $in: ['new', 'failed'] } }) : none,
    viewer.can('reviews') ? DeliveryReview.countDocuments({ status: 'pending' }) : none,
    viewer.can('sync') ? SyncOperation.countDocuments({ state: { $in: ['failed', 'needs_reconciliation'] } }) : none,
    viewer.can('sync') ? WebhookEvent.countDocuments({ status: { $in: ['failed', 'pending_retry'] } }) : none,
    viewer.can('orders') ? Order.countDocuments(VISIBLE) : none,
    viewer.can('cash') ? cashOverview() : none,
  ]);
  const stats = {};
  if (byDelivery) {
    const d = Object.fromEntries(byDelivery.map((x) => [x._id, x.n]));
    stats.orders = {
      total,
      new: d.new || 0,
      unassigned,
      assigned: d.assigned || 0,
      outForDelivery: d.out_for_delivery || 0,
      pendingReview: d.pending_delivery_review || 0,
      delivered: d.delivered || 0,
      failed: d.failed || 0,
      cancelled: d.cancelled || 0,
      returned: d.returned || 0,
    };
  }
  if (pendingReviews !== null) stats.pendingReviews = pendingReviews;
  if (syncFailures !== null) stats.sync = { failures: syncFailures, webhookFailures };
  if (cash) {
    stats.cash = {
      expected: cash.expectedDelivered,
      handedOver: cash.handedOver,
      verified: cash.verified,
      outstanding: cash.outstanding,
      discrepancy: cash.discrepancy,
    };
  }
  return stats;
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
