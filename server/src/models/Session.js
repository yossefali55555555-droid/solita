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
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ user: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
