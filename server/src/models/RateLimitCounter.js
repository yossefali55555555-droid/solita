import mongoose from 'mongoose';

/**
 * Persistent fixed-window counters. Used for login rate limiting and for the
 * outbound EasyOrders request budget, because serverless instances do not
 * share memory.
 */
const rateLimitCounterSchema = new mongoose.Schema({
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  resetAt: { type: Date, required: true },
});

rateLimitCounterSchema.index({ key: 1 }, { unique: true });
rateLimitCounterSchema.index({ resetAt: 1 }, { expireAfterSeconds: 60 });

export const RateLimitCounter =
  mongoose.models.RateLimitCounter || mongoose.model('RateLimitCounter', rateLimitCounterSchema);
