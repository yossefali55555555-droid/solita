import mongoose from 'mongoose';

/**
 * Server-side sessions. The cookie holds a random token; only its SHA-256
 * hash is stored, so a database leak does not reveal usable session tokens.
 * Expired sessions are removed by a TTL index.
 */
const sessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date },
    userAgent: { type: String, maxlength: 300 },
    // Phase 3: when 2FA was checked at sign-in, the last identity check
    // (sign-in or step-up, for the 10-minute rule) and a one-shot step-up
    // for one dangerous action (60 seconds).
    mfaVerifiedAt: { type: Date, default: null },
    reauthAt: { type: Date, default: null },
    stepUp: {
      action: { type: String, maxlength: 60 },
      at: { type: Date },
    },
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ user: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
