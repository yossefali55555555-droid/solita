import mongoose from 'mongoose';

/**
 * "Before sign-in" record of the two-stage admin login (SPEC (هـ)): the
 * password was right, a 2FA code is still needed. It is not a session: it
 * only works for POST /auth/2fa/verify, lives 5 minutes and is burnt after
 * 5 wrong codes. Only the SHA-256 of the cookie token is stored.
 */
const preAuthSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    ip: { type: String, maxlength: 80 },
    userAgent: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

preAuthSchema.index({ tokenHash: 1 }, { unique: true });
preAuthSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PreAuth = mongoose.models.PreAuth || mongoose.model('PreAuth', preAuthSchema);
