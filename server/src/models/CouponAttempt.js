import mongoose from 'mongoose';

/**
 * A storefront attempt to use a customer-bound coupon that was refused:
 * wrong phone, a code nobody owns, an expired code, or a malformed phone.
 * Shown in the dashboard so the owner can see who tries codes that are not theirs.
 * `visitorId` links to the visitor's cart contact (name/phone typed at checkout).
 */
const couponAttemptSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, lowercase: true, maxlength: 60 },
    reason: { type: String, enum: ['wrong_phone', 'unassigned', 'expired', 'bad_phone'], required: true },
    stage: { type: String, enum: ['apply', 'submit'], default: 'apply' },
    phoneTyped: { type: String, maxlength: 40, default: '' },
    phoneNormalized: { type: String, maxlength: 40, default: '' },
    name: { type: String, maxlength: 200, default: '' },
    visitorId: { type: String, maxlength: 64, default: '' },
    // Who the code really belongs to (for the owner's eyes only).
    ownerPhone: { type: String, maxlength: 40, default: '' },
    ownerName: { type: String, maxlength: 200, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

couponAttemptSchema.index({ createdAt: -1 });
// Keep six months of attempts.
couponAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const CouponAttempt =
  mongoose.models.CouponAttempt || mongoose.model('CouponAttempt', couponAttemptSchema, 'coupon_attempts');
