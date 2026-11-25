import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Alerts for the administrator (SPEC (ح)): an in-app notice + a line in the
 * end-of-day email; security events also send an email at once. Repeats of
 * the same event (same `key`, still unread, same day) are merged into one
 * document with a counter instead of piling up. Kept 180 days (TTL).
 * Size: a few hundred bytes each, a handful per day.
 */
export const ALERT_RETENTION_DAYS = 180;

const securityAlertSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 200 },
    type: { type: String, required: true, maxlength: 60 },
    severity: { type: String, enum: ['security', 'normal'], default: 'normal' },
    message: { type: String, required: true, maxlength: 500 },
    actor: {
      user: { type: ObjectId, ref: 'User', default: null },
      name: { type: String, maxlength: 120 },
      role: { type: String, maxlength: 20 },
    },
    count: { type: Number, default: 1 },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    readAt: { type: Date, default: null },
    emailedAt: { type: Date, default: null }, // last immediate email
    digestedAt: { type: Date, default: null }, // included in an end-of-day email
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

securityAlertSchema.index({ key: 1, readAt: 1, firstAt: -1 });
securityAlertSchema.index({ lastAt: -1 });
securityAlertSchema.index({ digestedAt: 1, lastAt: 1 });
securityAlertSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SecurityAlert = mongoose.models.SecurityAlert || mongoose.model('SecurityAlert', securityAlertSchema);
