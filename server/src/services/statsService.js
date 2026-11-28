import { CashRemittance, DeliveryReview, MissedOrder, Order, StorefrontCart, SyncOperation, WebhookEvent } from '../models/index.js';
import { NOT_TEST } from '../models/Order.js';
import { getConfig } from '../config/env.js';
import { cashOverview, getCashResetAt } from './cashService.js';
import { printQueueCounts } from './labelService.js';
import { PENDING_RETURNS } from './returnService.js';
import { cairoDayStart } from './storefrontService.js';
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

/**
 * Small numbers shown next to the navigation tabs: work waiting on someone.
 * Each one is only counted for a viewer who may open its page, and matches
 * what that page (or «محتاجك» on the home page) shows.
 */
async function countDeclaredRemittances() {
  const resetAt = await getCashResetAt();
  return CashRemittance.countDocuments({ status: 'declared', ...(resetAt ? { createdAt: { $gt: resetAt } } : {}) });
}

export async function getNavCounts(viewer = FULL_VIEWER, { now = new Date() } = {}) {
  const none = Promise.resolve(null);
  const [missedOrders, abandonedCarts, labels, reviews, returns, cashDeclared] = await Promise.all([
    // Missed orders nobody has contacted or dismissed yet.
    viewer.can('missedOrders') ? MissedOrder.countDocuments({ isTest: false, contactedAt: null, dismissedAt: null }) : none,
    // Abandoned carts of the last 7 days not contacted yet.
    viewer.can('storefront')
      ? StorefrontCart.countDocuments({ status: 'open', itemsCount: { $gt: 0 }, lastActivityAt: { $gte: cairoDayStart(now, 6) } })
      : none,
    viewer.can('warehouse') ? printQueueCounts() : none,
    viewer.can('reviews') ? DeliveryReview.countDocuments({ status: 'pending' }) : none,
    viewer.can('warehouse') ? Order.countDocuments(PENDING_RETURNS) : none,
    // Cash settlements a courier has declared and nobody has received yet (same window as the cash page list).
    viewer.can('cash') ? countDeclaredRemittances() : none,
  ]);
  const counts = {};
  if (missedOrders !== null) counts.missedOrders = missedOrders;
  if (abandonedCarts !== null) counts.abandonedCarts = abandonedCarts;
  if (labels) counts.labels = labels.pending + labels.reprint;
  if (reviews !== null) counts.reviews = reviews;
  if (returns !== null) counts.returns = returns;
  if (cashDeclared !== null) counts.cashDeclared = cashDeclared;
  return counts;
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
