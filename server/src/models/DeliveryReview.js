import mongoose from 'mongoose';
import { REVIEW_STATUSES, REVIEW_SYNC_STATUSES } from '../constants/statuses.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A courier's delivery-completion report awaiting supervisor decision.
 * Reviews are never deleted: rejected reports stay in history and a
 * resubmission creates a new review document.
 */
const deliveryReviewSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: 'Order', required: true },
    courier: { type: ObjectId, ref: 'User', required: true },
    submittedAt: { type: Date, default: Date.now },
    status: { type: String, enum: REVIEW_STATUSES, default: 'pending' },
    reviewer: { type: ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, maxlength: 1000 },
    courierNote: { type: String, maxlength: 1000 },
    proofReference: { type: String, maxlength: 300 },
    collectedAmount: { type: Number, default: null }, // piasters, COD orders only
    expectedAmount: { type: Number, default: 0 },
    sourceStatusAtSubmission: { type: String, maxlength: 60 },
    submissionNumber: { type: Number, default: 1 },
    syncStatus: { type: String, enum: REVIEW_SYNC_STATUSES, default: 'not_started' },
    syncOperation: { type: ObjectId, ref: 'SyncOperation', default: null },
    syncAttempts: { type: Number, default: 0 },
    lastSyncError: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

// At most one pending review per order (prevents duplicate submissions).
deliveryReviewSchema.index(
  { order: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_review_per_order' },
);
deliveryReviewSchema.index({ status: 1, submittedAt: 1 });
deliveryReviewSchema.index({ courier: 1, submittedAt: -1 });
deliveryReviewSchema.index({ order: 1, submittedAt: -1 });

export const DeliveryReview =
  mongoose.models.DeliveryReview || mongoose.model('DeliveryReview', deliveryReviewSchema);
