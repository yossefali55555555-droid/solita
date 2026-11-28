import mongoose from 'mongoose';

/**
 * Invite link of a staff account (SPEC (هـ)): a 256-bit random token, stored
 * only as a SHA-256 hash, valid 48 hours, one use. Disabling the account or
 * generating a new invite deletes the old ones. Expired rows leave by TTL.
 */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

const inviteSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inviteSchema.index({ tokenHash: 1 }, { unique: true });
inviteSchema.index({ user: 1 });
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AccountInvite = mongoose.models.AccountInvite || mongoose.model('AccountInvite', inviteSchema);
