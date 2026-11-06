/**
 * Status vocabularies.
 *
 * Four independent concepts are tracked and must never be confused:
 *  - sourceStatus:   the raw EasyOrders order status (owned by EasyOrders)
 *  - deliveryStatus: Solita's internal delivery workflow status
 *  - review status:  supervisor decision on a courier's delivery report
 *  - sync state:     outcome of pushing a status to EasyOrders
 */

// Documented values of the EasyOrders "Update Order Status" API
// (https://public-api-docs.easy-orders.net/docs/update-order-status).
// Unknown values received from EasyOrders are stored as-is and never crash the app.
export const EASYORDERS_STATUSES = Object.freeze([
  'pending',
  'confirmed',
  'pending_payment',
  'paid',
  'paid_failed',
  'processing',
  'waiting_for_pickup',
  'in_delivery',
  'delivered',
  'canceled',
  'returning_from_delivery',
  'request_refund',
  'refund_in_progress',
  'refunded',
]);

export const DELIVERY_STATUSES = Object.freeze([
  'new',
  'assigned',
  'out_for_delivery',
  'pending_delivery_review',
  'delivered',
  'failed',
  'cancelled',
  // Admin confirmed a failed/refused delivery as a return (مرتجع).
  'returned',
]);

/**
 * Allowed internal transitions. Every state change in the services goes
 * through assertTransition() and a conditional (compare-and-set) update.
 */
export const DELIVERY_TRANSITIONS = Object.freeze({
  new: ['assigned', 'cancelled'],
  assigned: ['assigned', 'new', 'out_for_delivery', 'failed', 'cancelled'],
  out_for_delivery: ['assigned', 'new', 'pending_delivery_review', 'failed', 'cancelled'],
  pending_delivery_review: ['delivered', 'out_for_delivery', 'cancelled'],
  failed: ['assigned', 'new', 'out_for_delivery', 'cancelled', 'returned'],
  delivered: [],
  cancelled: ['new'],
  returned: ['new'],
});

/**
 * EasyOrders statuses an administrator may push after confirming a return.
 * Both are documented values of the Update Order Status API:
 *  - returning_from_delivery: the order is coming back from the courier (default)
 *  - canceled: the order is cancelled (e.g. refused before any handover)
 */
export const RETURN_SYNC_STATUSES = Object.freeze(['returning_from_delivery', 'canceled']);

export function canTransition(from, to) {
  return (DELIVERY_TRANSITIONS[from] || []).includes(to);
}

export const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

export const REVIEW_SYNC_STATUSES = Object.freeze(['not_started', 'pending', 'synced', 'failed']);

export const SYNC_OPERATION_STATES = Object.freeze([
  'pending', // created, not attempted yet
  'in_progress', // claimed by a worker (lease in lockedUntil)
  'retry_scheduled', // temporary failure / rate limit, retried after nextAttemptAt
  'needs_reconciliation', // ambiguous outcome (timeout); check EasyOrders before retrying
  'succeeded', // EasyOrders confirmed the change
  'failed', // permanent error or retries exhausted; manual retry possible
]);

export const SYNC_TERMINAL_STATES = Object.freeze(['succeeded', 'failed']);

export const FAILURE_REASONS = Object.freeze([
  'no_answer',
  'reschedule_requested',
  'address_not_found',
  'customer_refused',
  'payment_refused',
  'other',
]);

export const EXPENSE_CATEGORIES = Object.freeze([
  'purchases', // بضاعة / مشتريات
  'shipping', // شحن
  'ads', // إعلانات
  'salaries', // رواتب
  'rent', // إيجار
  'packaging', // تغليف
  'utilities', // كهرباء / إنترنت / مرافق
  'other',
]);

export const REMITTANCE_STATUSES = Object.freeze([
  'declared', // courier declared cash handed over, awaiting admin receipt
  'received', // admin recorded the actual handed-over amount
  'reconciled', // admin verified; matches expected
  'discrepancy', // admin verified; differs from expected
  'cancelled', // voided before reconciliation (orders released)
]);

export const ROLES = Object.freeze(['admin', 'courier']);

/** Derive a payment status from the EasyOrders status (source-controlled). */
export function paymentStatusFromSource(sourceStatus, previous = 'unpaid') {
  switch (sourceStatus) {
    case 'paid':
      return 'paid';
    case 'paid_failed':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'pending_payment':
      return 'unpaid';
    default:
      return previous || 'unpaid';
  }
}

export function isCashOnDelivery(paymentMethod) {
  if (!paymentMethod) return false;
  const v = String(paymentMethod).toLowerCase();
  return v === 'cod' || v.includes('cash');
}
