import mongoose from 'mongoose';

/**
 * Small key/value documents for integration bookkeeping, e.g. the EasyOrders
 * order-number cursor used by the pull sync. `lockedUntil` is a lease so two
 * serverless invocations never run the same job at the same time.
 */
const integrationStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 100 },
    lastShortId: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

integrationStateSchema.index({ key: 1 }, { unique: true });

export const IntegrationState =
  mongoose.models.IntegrationState || mongoose.model('IntegrationState', integrationStateSchema);
