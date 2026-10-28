import { DeliveryReview, Order, SyncOperation } from '../models/index.js';
import { EASYORDERS_STATUSES, SYNC_TERMINAL_STATES } from '../constants/statuses.js';
import { EasyOrdersError, getOrder, updateOrderStatus } from '../integrations/easyorders/client.js';
import { conflict, isDuplicateKeyError, notFound } from '../utils/errors.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_ACTOR, recordEvent, userActor } from './auditService.js';

/**
 * Solita → EasyOrders status synchronization.
 *
 * 1. The workflow records the intended change as a SyncOperation (unique
 *    idempotency key, so the same intent is never recorded twice).
 * 2. processOperation() claims it with an atomic lease, calls the documented
 *    API and records the real outcome.
 * 3. Failures are classified:
 *      429 / local budget        → retry after the rate-limit window
 *      timeout / 5xx on PATCH    → ambiguous: reconcile (GET) before retrying
 *      connection failure        → retry with exponential backoff
 *      other 4xx                 → permanent failure, no automatic retry
 *      missing API key           → failed until configured, manual retry
 * 4. Operations for the same order run strictly in creation order.
 *
 * Success is recorded only after EasyOrders answers 2xx (or a reconciliation
 * read shows the target status is already applied).
 */

const ACTIVE_STATES = ['pending', 'retry_scheduled', 'needs_reconciliation'];
const LEASE_MS = 60_000;

function backoffMs(attempts) {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export async function enqueueStatusSync({ order, targetStatus, trigger, review = null, requestedBy = null, idempotencyKey }) {
  if (!EASYORDERS_STATUSES.includes(targetStatus)) {
    throw new Error(`Refusing to sync undocumented EasyOrders status "${targetStatus}"`);
  }
  let op;
  try {
    op = await SyncOperation.create({
      order: order._id,
      easyOrdersId: order.easyOrdersId,
      targetStatus,
      trigger,
      review: review?._id || null,
      requestedBy: requestedBy?._id || null,
      idempotencyKey,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return SyncOperation.findOne({ idempotencyKey });
    throw err;
  }
  await Order.updateOne({ _id: order._id }, { $set: { 'sync.state': 'pending' } });
  await recordEvent({
    order: order._id,
    type: 'sync_requested',
    actor: requestedBy ? userActor(requestedBy) : SYSTEM_ACTOR,
    next: { targetStatus },
    syncOutcome: 'pending',
    metadata: { trigger, operation: op._id },
  });
  return op;
}

async function refreshOrderSyncSummary(orderId, { lastError } = {}) {
  const ops = await SyncOperation.find({ order: orderId }).sort({ createdAt: -1 }).limit(20).lean();
  let state = 'none';
  if (ops.some((o) => !SYNC_TERMINAL_STATES.includes(o.state))) state = 'pending';
  else if (ops[0]?.state === 'succeeded') state = 'synced';
  else if (ops[0]?.state === 'failed') state = 'failed';
  const set = { 'sync.state': state };
  if (lastError !== undefined) set['sync.lastError'] = lastError;
  await Order.updateOne({ _id: orderId }, { $set: set });
}

async function markSucceeded(op, { reconciled = false } = {}) {
  const now = new Date();
  await SyncOperation.updateOne(
    { _id: op._id },
    {
      $set: {
        state: 'succeeded',
        completedAt: now,
        lockedUntil: null,
        reconcileFirst: false,
        lastError: null,
        reconciledVia: reconciled ? 'api_check' : null,
      },
    },
  );
  const order = await Order.findById(op.order).lean();
  await Order.updateOne(
    { _id: op.order },
    {
      $set: {
        sourceStatus: op.targetStatus,
        sourceStatusUpdatedAt: now,
        sourceStatusNeedsVerification: false,
        'sync.lastPushedStatus': op.targetStatus,
        'sync.lastPushedAt': now,
        'sync.lastError': null,
        lastSyncedToSourceAt: now,
      },
    },
  );
  await refreshOrderSyncSummary(op.order);
  if (op.review) {
    await DeliveryReview.updateOne(
      { _id: op.review },
      { $set: { syncStatus: 'synced', lastSyncError: null }, $inc: { syncAttempts: 1 } },
    );
  }
  await recordEvent({
    order: op.order,
    type: 'sync_succeeded',
    actor: SYSTEM_ACTOR,
    previous: { sourceStatus: order?.sourceStatus },
    next: { sourceStatus: op.targetStatus },
    syncOutcome: reconciled ? 'reconciled' : 'succeeded',
    metadata: { operation: op._id, attempts: op.attempts, trigger: op.trigger },
  });
  return SyncOperation.findById(op._id).lean();
}

async function handleFailure(op, err) {
  const now = Date.now();
  const message = sanitizeError(err);
  const set = { lockedUntil: null, lastError: message };
  const inc = {};
  let finalFailure = false;

  if (!(err instanceof EasyOrdersError)) {
    // Our own failure (e.g. database hiccup) – retry later.
    set.state = 'retry_scheduled';
    set.nextAttemptAt = new Date(now + 60_000);
  } else {
    set.lastHttpStatus = err.status ?? null;
    switch (err.kind) {
      case 'rate_limited':
        set.state = op.reconcileFirst ? 'needs_reconciliation' : 'retry_scheduled';
        set.nextAttemptAt = new Date(now + (err.retryAfterMs || 60_000));
        inc.rateLimitedCount = 1;
        inc.attempts = -1; // rate limiting does not consume the retry budget
        break;
      case 'not_configured':
        set.state = 'failed';
        set.permanentError = false;
        finalFailure = true;
        break;
      case 'client':
        set.state = 'failed';
        set.permanentError = true;
        finalFailure = true;
        break;
      default: {
        const exhausted = op.attempts >= op.maxAttempts;
        if (err.ambiguous) set.reconcileFirst = true;
        if (exhausted) {
          set.state = 'failed';
          finalFailure = true;
        } else {
          set.state = err.ambiguous || op.reconcileFirst ? 'needs_reconciliation' : 'retry_scheduled';
          set.nextAttemptAt = new Date(now + (err.ambiguous ? 30_000 : backoffMs(op.attempts)));
        }
      }
    }
  }

  await SyncOperation.updateOne({ _id: op._id }, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) });
  await refreshOrderSyncSummary(op.order, { lastError: message });

  if (op.review) {
    await DeliveryReview.updateOne(
      { _id: op.review },
      {
        $set: { syncStatus: finalFailure ? 'failed' : 'pending', lastSyncError: message },
        $inc: { syncAttempts: err?.kind === 'rate_limited' ? 0 : 1 },
      },
    );
  }

  if (err?.kind !== 'rate_limited') {
    await recordEvent({
      order: op.order,
      type: 'sync_failed',
      actor: SYSTEM_ACTOR,
      next: { targetStatus: op.targetStatus },
      syncOutcome: set.state,
      reason: message,
      metadata: { operation: op._id, attempts: op.attempts, httpStatus: err?.status, kind: err?.kind },
    });
  }
  logger.warn('EasyOrders sync attempt failed', {
    operation: String(op._id),
    state: set.state,
    kind: err?.kind,
    httpStatus: err?.status,
  });
  return SyncOperation.findById(op._id).lean();
}

/**
 * Attempt one operation now (if it is due and not leased). Safe to call
 * concurrently: only one caller can claim the lease.
 */
export async function processOperation(operationId) {
  const now = new Date();
  const current = await SyncOperation.findById(operationId).lean();
  if (!current) return null;
  if (!ACTIVE_STATES.includes(current.state) && current.state !== 'in_progress') return current;

  const blocker = await SyncOperation.exists({
    order: current.order,
    _id: { $ne: current._id },
    createdAt: { $lt: current.createdAt },
    state: { $nin: SYNC_TERMINAL_STATES },
  });
  if (blocker) return current;

  const before = await SyncOperation.findOneAndUpdate(
    {
      _id: operationId,
      $and: [
        {
          $or: [
            { state: { $in: ACTIVE_STATES }, nextAttemptAt: { $lte: now } },
            { state: 'in_progress', lockedUntil: { $lte: now } }, // abandoned lease
          ],
        },
        { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      ],
    },
    {
      $set: { state: 'in_progress', lockedUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'before' },
  ).lean();
  if (!before) return SyncOperation.findById(operationId).lean();

  // A worker that died mid-request leaves an ambiguous outcome behind.
  const reconcileFirst = before.reconcileFirst || before.state === 'in_progress';
  const op = { ...before, attempts: before.attempts + 1, reconcileFirst };

  try {
    if (reconcileFirst) {
      const remote = await getOrder(op.easyOrdersId);
      if (remote.status === op.targetStatus) return await markSucceeded(op, { reconciled: true });
    }
    await updateOrderStatus(op.easyOrdersId, op.targetStatus);
    return await markSucceeded(op);
  } catch (err) {
    return handleFailure(op, err);
  }
}

/** Process due operations, oldest first, until the time budget is used. */
export async function processDueOperations({ limit = 25, timeBudgetMs = 20_000 } = {}) {
  const started = Date.now();
  const now = new Date();
  const due = await SyncOperation.find({
    $or: [
      { state: { $in: ACTIVE_STATES }, nextAttemptAt: { $lte: now } },
      { state: 'in_progress', lockedUntil: { $lte: now } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

  const results = { processed: 0, succeeded: 0, failed: 0, deferred: 0 };
  for (const { _id } of due) {
    if (Date.now() - started > timeBudgetMs) break;
    const op = await processOperation(_id);
    results.processed += 1;
    if (op?.state === 'succeeded') results.succeeded += 1;
    else if (op?.state === 'failed') results.failed += 1;
    else results.deferred += 1;
  }
  return results;
}

/** Manual retry by an administrator. */
export async function retryOperation(operationId, admin) {
  const op = await SyncOperation.findById(operationId);
  if (!op) throw notFound('عملية المزامنة غير موجودة');
  if (op.state === 'succeeded') throw conflict('تمت هذه المزامنة بنجاح بالفعل', 'ALREADY_SYNCED');
  if (op.state === 'in_progress' && op.lockedUntil && op.lockedUntil > new Date()) {
    throw conflict('جاري تنفيذ هذه المزامنة الآن', 'SYNC_IN_PROGRESS');
  }
  const update = {
    state: op.reconcileFirst ? 'needs_reconciliation' : 'pending',
    nextAttemptAt: new Date(),
    lockedUntil: null,
    permanentError: false,
  };
  if (op.attempts >= op.maxAttempts) update.maxAttempts = op.attempts + 3;
  const res = await SyncOperation.updateOne({ _id: op._id, state: op.state, updatedAt: op.updatedAt }, { $set: update });
  if (res.modifiedCount !== 1) throw conflict();

  if (op.review) await DeliveryReview.updateOne({ _id: op.review }, { $set: { syncStatus: 'pending' } });
  await recordEvent({
    order: op.order,
    type: 'sync_retry_requested',
    actor: userActor(admin),
    next: { targetStatus: op.targetStatus },
    metadata: { operation: op._id, previousState: op.state },
  });
  return processOperation(op._id);
}

export async function listSyncProblems({ skip = 0, limit = 20 } = {}) {
  const filter = { state: { $in: ['failed', 'needs_reconciliation', 'retry_scheduled'] } };
  const [items, total] = await Promise.all([
    SyncOperation.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('order', 'easyOrdersId easyOrdersShortId customer.name deliveryStatus sourceStatus')
      .populate('requestedBy', 'name role')
      .lean(),
    SyncOperation.countDocuments(filter),
  ]);
  return { items, total };
}
