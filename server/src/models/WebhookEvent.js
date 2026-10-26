import mongoose from 'mongoose';

const { Mixed } = mongoose.Schema.Types;

/**
 * Every inbound webhook delivery. EasyOrders does not document an event id,
 * so deduplication uses a SHA-256 hash of the canonical payload (scoped to
 * the event kind). The raw payload is kept only until processing succeeds,
 * so failed deliveries can be reprocessed by the background job.
 */
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'easyorders' },
    eventId: { type: String, maxlength: 200 }, // provider event id, if one is ever sent
    eventType: { type: String, enum: ['order', 'order-status-update', 'unknown'], required: true },
    externalOrderId: { type: String, maxlength: 100 },
    payloadHash: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['received', 'processing', 'processed', 'ignored', 'failed', 'pending_retry'],
      default: 'received',
    },
    outcome: { type: String, maxlength: 80 },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
    payload: { type: Mixed, select: false },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    lastError: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

webhookEventSchema.index({ provider: 1, dedupeKey: 1 }, { unique: true });
webhookEventSchema.index({ status: 1, nextAttemptAt: 1 });
webhookEventSchema.index({ externalOrderId: 1, receivedAt: -1 });

export const WebhookEvent =
  mongoose.models.WebhookEvent || mongoose.model('WebhookEvent', webhookEventSchema);
