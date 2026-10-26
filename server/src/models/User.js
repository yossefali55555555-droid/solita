import mongoose from 'mongoose';
import { ROLES } from '../constants/statuses.js';
import { normalizePhone } from '../utils/phone.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: { type: Date },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    lastLoginAt: { type: Date },
    isDemo: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.failedLoginCount;
        delete ret.lockedUntil;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.pre('validate', function normalize() {
  if (this.phone) this.phone = normalizePhone(this.phone);
  if (this.email === '') this.email = undefined;
});

userSchema.index({ phone: 1 }, { unique: true });
// Email is optional: a partial index only enforces uniqueness for documents
// that actually have an email (missing emails are never duplicates).
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index({ role: 1, isActive: 1 });

export const User = mongoose.models.User || mongoose.model('User', userSchema);

export function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.name,
    phone: user.phone,
    email: user.email || null,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: Boolean(user.mustChangePassword),
    lastLoginAt: user.lastLoginAt || null,
    isDemo: Boolean(user.isDemo),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
