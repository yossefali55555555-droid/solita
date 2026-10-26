import { Order, WebhookEvent } from '../models/index.js';
import { EasyOrdersError, getOrder, isEasyOrdersConfigured } from '../integrations/easyorders/client.js';
import {
  extractExternalOrderId,
  isCompleteOrderPayload,
  normalizeEasyOrdersOrder,
} from '../integrations/easyorders/normalize.js';
import { canonicalJson, sanitizeError, sha256 } from '../utils/sanitize.js';
import { isDuplicateKeyError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { applySourceStatusChange, upsertOrderFromSource } from './sourceOrderService.js';

/**
 * EasyOrders → Solita webhook processing.
 *
 * Documented payloads (https://public-api-docs.easy-orders.net/docs/webhooks):
 *  - Order created: the full order object (id, status, cart_items, ...)
 *  - Order status change: { event_type: "order-status-update", order_id,
 *    old_status, new_status, payment_ref_id }
 * Authentication: the `secret` request header (checked in the controller).
 *
 * Inbound processing never enqueues outbound EasyOrders updates, so the app
 * cannot loop on its own changes.
 */

const MAX_WEBHOOK_ATTEMPTS = 10;
// A byte-identical status payload received again after this window is
// treated as a new event (e.g. a status that really changed back and forth).
const STATUS_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

export class RetryableWebhookError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RetryableWebhookError';
  }
}

export function detectEventType(body) {
  if (body && body.event_type === 'order-status-update') return 'order-status-update';
  if (body && extractExternalOrderId(body) && (Array.isArray(body.cart_items) || 'full_name' in body || 'status' in body)) {
    return 'order';
  }
  return 'unknown';
}

/**
 * Store and process a webhook delivery.
 * Returns { httpStatus, body } for the controller.
 */
export async function receiveWebhook(body) {
  const eventType = detectEventType(body);
  const externalOrderId = eventType === 'order-status-update' ? extractExternalOrderId({ order_id: body.order_id }) : extractExternalOrderId(body);
  const payloadHash = sha256(canonicalJson(body ?? null));

  if (eventType === 'unknown' || !externalOrderId) {
    await WebhookEvent.create({
      eventType: 'unknown',
      externalOrderId: externalOrderId || undefined,
      payloadHash,
      dedupeKey: `unknown:${payloadHash}:${Date.now()}`,
      status: 'ignored',
      outcome: 'unrecognized_payload',
      processedAt: new Date(),
    });
    return { httpStatus: 200, body: { received: true, ignored: true } };
  }

  let event;
  const baseKey = `${eventType}:${payloadHash}`;
  try {
    event = await WebhookEvent.create({
      eventType,
      externalOrderId,
      payloadHash,
      dedupeKey: baseKey,
      status: 'processing',
      attempts: 1,
      payload: body,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await WebhookEvent.findOne({ provider: 'easyorders', dedupeKey: baseKey });
    const stale = existing && Date.now() - existing.receivedAt.getTime() > STATUS_DEDUPE_WINDOW_MS;
    if (eventType === 'order-status-update' && stale) {
      event = await WebhookEvent.create({
        eventType,
        externalOrderId,
        payloadHash,
        dedupeKey: `${baseKey}:${Date.now()}`,
        status: 'processing',
        attempts: 1,
        payload: body,
      });
    } else if (existing && ['failed', 'pending_retry'].includes(existing.status)) {
      // Provider redelivered an event we could not process: try again now.
      const claimed = await WebhookEvent.findOneAndUpdate(
        { _id: existing._id, status: { $in: ['failed', 'pending_retry'] } },
        { $set: { status: 'processing' }, $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      );
      if (!claimed) return { httpStatus: 200, body: { received: true, duplicate: true } };
      event = claimed;
    } else {
      return { httpStatus: 200, body: { received: true, duplicate: true } };
    }
  }

  const result = await processStoredEvent(event, body);
  return {
    httpStatus: result.status === 'pending_retry' ? 202 : 200,
    body: { received: true, outcome: result.outcome },
  };
}

async function processStoredEvent(event, body) {
  try {
    const outcome =
      event.eventType === 'order-status-update' ? await processStatusEvent(body) : await processOrderEvent(body);
    await WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { status: 'processed', outcome, processedAt: new Date(), lastError: null }, $unset: { payload: 1 } },
    );
    return { status: 'processed', outcome };
  } catch (err) {
    const attempts = event.attempts || 1;
    const retryable = attempts < MAX_WEBHOOK_ATTEMPTS;
    const delay = Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1));
    const status = retryable ? 'pending_retry' : 'failed';
    await WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status,
          outcome: err instanceof RetryableWebhookError ? 'deferred' : 'error',
          lastError: sanitizeError(err),
          nextAttemptAt: retryable ? new Date(Date.now() + delay) : null,
        },
      },
    );
    logger.warn('Webhook processing failed', { event: String(event._id), status, error: err.message });
    return { status, outcome: 'deferred' };
  }
}

async function fetchAndUpsert(externalOrderId, via) {
  try {
    const remote = await getOrder(externalOrderId);
    const { outcome } = await upsertOrderFromSource(normalizeEasyOrdersOrder(remote), { via });
    return outcome;
  } catch (err) {
    if (err instanceof EasyOrdersError) {
      if (err.kind === 'client' && err.status === 404) {
        throw new Error(`EasyOrders order ${externalOrderId} was not found (HTTP 404)`, { cause: err });
      }
      throw new RetryableWebhookError(`Could not fetch order from EasyOrders: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

async function processOrderEvent(body) {
  const externalOrderId = extractExternalOrderId(body);
  if (!isCompleteOrderPayload(body)) {
    // Partial payload: prefer the authoritative full order when the API is available.
    if (isEasyOrdersConfigured()) return `partial_${await fetchAndUpsert(externalOrderId, 'webhook_fetch')}`;
    const exists = await Order.exists({ easyOrdersId: externalOrderId });
    if (!exists) throw new RetryableWebhookError('Partial payload for an unknown order and no EasyOrders API key to fetch it');
  }
  const { outcome } = await upsertOrderFromSource(normalizeEasyOrdersOrder(body), { via: 'webhook' });
  return outcome;
}

async function processStatusEvent(body) {
  const externalOrderId = extractExternalOrderId({ order_id: body.order_id });
  const newStatus = typeof body.new_status === 'string' ? body.new_status.trim().slice(0, 60) : '';
  const oldStatus = typeof body.old_status === 'string' ? body.old_status.trim().slice(0, 60) : null;
  if (!newStatus) return 'ignored_missing_status';

  const order = await Order.findOne({ easyOrdersId: externalOrderId });
  if (!order) {
    if (isEasyOrdersConfigured()) return `unknown_order_${await fetchAndUpsert(externalOrderId, 'status_webhook_fetch')}`;
    throw new RetryableWebhookError('Status update for an unknown order and no EasyOrders API key to fetch it');
  }

  // Echo of a change Solita itself pushed (sourceStatus is set on confirmed push).
  if (order.sourceStatus === newStatus) return 'no_change';

  const pushedRecently =
    order.sync?.lastPushedStatus === newStatus &&
    order.sync?.lastPushedAt &&
    Date.now() - order.sync.lastPushedAt.getTime() < 15 * 60_000;

  const outOfSequence = Boolean(oldStatus && order.sourceStatus && oldStatus !== order.sourceStatus);
  if (outOfSequence) {
    if (isEasyOrdersConfigured()) {
      return `out_of_sequence_${await fetchAndUpsert(externalOrderId, 'status_webhook_reconcile')}`;
    }
    await applySourceStatusChange(order, newStatus, {
      via: 'status_webhook',
      paymentRefId: body.payment_ref_id,
      needsVerification: true,
      echo: pushedRecently,
    });
    return 'out_of_sequence_applied_unverified';
  }

  await applySourceStatusChange(order, newStatus, {
    via: 'status_webhook',
    paymentRefId: body.payment_ref_id,
    echo: pushedRecently,
  });
  return pushedRecently ? 'echo_applied' : 'status_applied';
}

/** Reprocess deliveries that failed temporarily (used by the cron job). */
export async function processPendingWebhooks({ limit = 20, timeBudgetMs = 15_000 } = {}) {
  const started = Date.now();
  const results = { processed: 0, succeeded: 0, deferred: 0 };
  const due = await WebhookEvent.find({ status: 'pending_retry', nextAttemptAt: { $lte: new Date() } })
    .sort({ receivedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  for (const { _id } of due) {
    if (Date.now() - started > timeBudgetMs) break;
    const event = await WebhookEvent.findOneAndUpdate(
      { _id, status: 'pending_retry' },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    ).select('+payload');
    if (!event) continue;
    results.processed += 1;
    const res = await processStoredEvent(event, event.payload);
    if (res.status === 'processed') results.succeeded += 1;
    else results.deferred += 1;
  }
  return results;
}

export async function listWebhookProblems({ limit = 20 } = {}) {
  return WebhookEvent.find({ status: { $in: ['failed', 'pending_retry'] } })
    .sort({ receivedAt: -1 })
    .limit(limit)
    .lean();
}

/** Manual retry of a stored webhook (admin). */
export async function retryWebhookEvent(id) {
  const event = await WebhookEvent.findOneAndUpdate(
    { _id: id, status: { $in: ['failed', 'pending_retry'] } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).select('+payload');
  if (!event) return null;
  if (!event.payload) {
    await WebhookEvent.updateOne({ _id: id }, { $set: { status: 'failed', lastError: 'Payload no longer available' } });
    return WebhookEvent.findById(id).lean();
  }
  await processStoredEvent(event, event.payload);
  return WebhookEvent.findById(id).lean();
}
