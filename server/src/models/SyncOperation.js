import mongoose from 'mongoose';
import { SYNC_OPERATION_STATES } from '../constants/statuses.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Persistent record of an intended Solita → EasyOrders change. Operations are
 * processed inline right after the triggering action and, if that fails, by
 * the cron job or a manual retry. No in-memory queue is involved.
 */
const syncOperationSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: 'Order', required: true },
    easyOrdersId: { type: String, required: true },
    type: { type: String, enum: ['status_update'], default: 'status_update' },
    targetStatus: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    trigger: { type: String, maxlength: 60 }, // delivery_approved, delivery_started, order_cancelled...
    review: { type: ObjectId, ref: 'DeliveryReview', default: null },
    requestedBy: { type: ObjectId, ref: 'User', default: null },
    state: { type: String, enum: SYNC_OPERATION_STATES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    rateLimitedCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date, default: null },
    lastAttemptAt: { type: Date },
    lastHttpStatus: { type: Number },
    lastError: { type: String, maxlength: 500 },
    permanentError: { type: Boolean, default: false },
    // Set after an ambiguous outcome (timeout, crash mid-request): the next
    // attempt first reads the order from EasyOrders before patching again.
    reconcileFirst: { type: Boolean, default: false },
    completedAt: { type: Date },
    reconciledVia: { type: String, enum: ['api_check', null], default: null },
  },
  { timestamps: true },
);

syncOperationSchema.index({ idempotencyKey: 1 }, { unique: true });
syncOperationSchema.index({ state: 1, nextAttemptAt: 1 });
syncOperationSchema.index({ order: 1, createdAt: 1 });

export const SyncOperation =
  mongoose.models.SyncOperation || mongoose.model('SyncOperation', syncOperationSchema);
