import mongoose from 'mongoose';

/**
 * Per-product daily counters (Cairo calendar day) for the visitor behaviour
 * summary: product page views and add-to-cart events. Kept for 120 days.
 */
const storefrontDailyStatSchema = new mongoose.Schema(
  {
    day: { type: Date, required: true }, // start of the Cairo day (UTC instant)
    slug: { type: String, required: true, maxlength: 200 },
    name: { type: String, maxlength: 200, default: '' },
    views: { type: Number, default: 0 },
    adds: { type: Number, default: 0 },
  },
  { versionKey: false },
);

storefrontDailyStatSchema.index({ day: 1, slug: 1 }, { unique: true });
storefrontDailyStatSchema.index({ day: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

export const StorefrontDailyStat =
  mongoose.models.StorefrontDailyStat ||
  mongoose.model('StorefrontDailyStat', storefrontDailyStatSchema, 'storefront_daily_stats');
