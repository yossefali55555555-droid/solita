import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Security data of the administrator (moderators phase 3, SPEC (هـ)), kept
 * out of the User document so it can never leak through a user projection.
 * One document per account. Secrets are encrypted (TOTP) or hashed
 * (recovery codes, email codes); nothing here is ever sent to a client.
 */
const totpSchema = new mongoose.Schema(
  {
    secretEnc: { type: String, required: true }, // AES-256-GCM, see services/mfaCrypto.js
    keyVersion: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 }, // pending setup only
  },
  { _id: false },
);

const recoveryCodeSchema = new mongoose.Schema(
  { hash: { type: String, required: true }, usedAt: { type: Date, default: null } },
  { _id: false },
);

const accountSecuritySchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    // Active TOTP (2FA is on once this exists) and a pending one being set up.
    totp: { type: totpSchema, default: null },
    totpPending: { type: totpSchema, default: null },
    totpEnabledAt: { type: Date, default: null },
    lastTotpStep: { type: Number, default: null }, // replay guard
    recoveryCodes: { type: [recoveryCodeSchema], default: [] },
    recoveryCodesAt: { type: Date, default: null },
    // Owner's personal email, linked after a 6-digit code check.
    email: { type: String, default: null, maxlength: 200 },
    emailVerifiedAt: { type: Date, default: null },
    emailPending: {
      type: new mongoose.Schema(
        {
          address: { type: String, required: true, maxlength: 200 },
          codeHash: { type: String, required: true },
          expiresAt: { type: Date, required: true },
          attempts: { type: Number, default: 0 },
          sentAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    emailSends: { type: [Date], default: [] }, // last 24 h of verification sends (limit)
  },
  { timestamps: true },
);

accountSecuritySchema.index({ user: 1 }, { unique: true });

export const AccountSecurity =
  mongoose.models.AccountSecurity || mongoose.model('AccountSecurity', accountSecuritySchema);
