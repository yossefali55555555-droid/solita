import mongoose from 'mongoose';

/** Seconds a visit lasted on a page: bucket edges used for the median estimate. */
export const TIME_BUCKET_EDGES = Object.freeze([3, 10, 20, 40, 80, 160]);

export const DEVICES = Object.freeze(['mobile', 'tablet', 'desktop', 'unknown']);
export const SOURCES = Object.freeze(['direct', 'instagram', 'facebook', 'tiktok', 'google', 'whatsapp', 'other']);
export const OSES = Object.freeze(['android', 'ios', 'windows', 'mac', 'other']);

/**
 * Per page (path), per Cairo day, per device and traffic source: how many
 * visits, how long they stayed, how far they scrolled and how many left the
 * site from that page. A page appears here the first time the storefront
 * reports it, so new products and pages need no setup. Kept 120 days.
 */
const pageStatSchema = new mongoose.Schema(
  {
    day: { type: Date, required: true },
    path: { type: String, required: true, maxlength: 200 },
    device: { type: String, enum: DEVICES, default: 'unknown' },
    src: { type: String, enum: SOURCES, default: 'direct' },
    title: { type: String, maxlength: 200, default: '' },

    views: { type: Number, default: 0 },
    // Visits with a measured duration.
    timed: { type: Number, default: 0 },
    // Sum of the final per-visit active seconds (for the average).
    visitSeconds: { type: Number, default: 0 },
    // Visit-count per duration bucket (see TIME_BUCKET_EDGES), for the median.
    // (separate numeric fields, not an array: $inc on a missing array index would create an object)
    t0: { type: Number, default: 0 },
    t1: { type: Number, default: 0 },
    t2: { type: Number, default: 0 },
    t3: { type: Number, default: 0 },
    t4: { type: Number, default: 0 },
    t5: { type: Number, default: 0 },
    t6: { type: Number, default: 0 },
    // Visits that ended by leaving the site from this page.
    exits: { type: Number, default: 0 },
    scrollSum: { type: Number, default: 0 },
    scrollN: { type: Number, default: 0 },
    os: {
      android: { type: Number, default: 0 },
      ios: { type: Number, default: 0 },
      windows: { type: Number, default: 0 },
      mac: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
    },
  },
  { versionKey: false },
);

pageStatSchema.index({ day: 1, path: 1, device: 1, src: 1 }, { unique: true });
pageStatSchema.index({ day: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

export const PageStat = mongoose.models.PageStat || mongoose.model('PageStat', pageStatSchema, 'page_stats');
