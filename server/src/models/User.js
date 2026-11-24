import mongoose from 'mongoose';
import { ACCOUNT_STATUSES, ROLES } from '../constants/statuses.js';
import { DANGEROUS_KEYS, FIELD_KEYS, LEVELS, SECTION_KEYS } from '../constants/permissions.js';
import { AppError } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';

const { ObjectId } = mongoose.Schema.Types;

// Moderator permissions (see constants/permissions.js). Unknown keys throw.
const sectionsSchema = new mongoose.Schema(
  Object.fromEntries(SECTION_KEYS.map((key) => [key, { type: String, enum: LEVELS }])),
  { _id: false, strict: 'throw' },
);
const fieldGrantSchema = new mongoose.Schema(
  {
    key: { type: String, enum: FIELD_KEYS, required: true },
    until: { type: Date, default: null }, // null = permanent, a date = temporary grant
  },
  { _id: false, strict: 'throw' },
);
const permissionsSchema = new mongoose.Schema(
  {
    sections: { type: sectionsSchema, default: () => ({}) },
    dangerous: { type: [{ type: String, enum: DANGEROUS_KEYS }], default: [] },
    fields: { type: [fieldGrantSchema], default: [] },
  },
  { _id: false, strict: 'throw' },
);

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
    // Staff accounts (moderators). Admin has every permission implicitly.
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'active' },
    permissions: { type: permissionsSchema, default: undefined },
    templateName: { type: String, trim: true, maxlength: 80 },
    createdBy: { type: ObjectId, ref: 'User' },
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

// ---------------- One administrator only ----------------
// Layer 1 (database): partial unique index `one_admin_only`, built by the
// checked migration in db/migrations/singleAdmin.js (not declared here, so
// it is never auto-built over a database that still has several admins).
// Layer 2 (model): the hooks below refuse to create or promote a second admin.
// Layer 3 (API): validators never accept role "admin" and update routes
// only take whitelisted fields.
export const SECOND_ADMIN_MESSAGE = 'لا يمكن إنشاء أكثر من حساب أدمن واحد';
const secondAdmin = () => new AppError(409, 'SECOND_ADMIN_FORBIDDEN', SECOND_ADMIN_MESSAGE);

userSchema.pre('validate', async function oneAdminOnDocument() {
  if (this.role !== 'admin' || !(this.isNew || this.isModified('role'))) return;
  if (await this.constructor.exists({ role: 'admin', _id: { $ne: this._id } })) throw secondAdmin();
});

function setsAdminRole(update) {
  if (!update) return false;
  const stages = Array.isArray(update) ? update : [update];
  return stages.some(
    (u) =>
      u?.role === 'admin' ||
      u?.$set?.role === 'admin' ||
      u?.$setOnInsert?.role === 'admin' ||
      u?.$addFields?.role === 'admin',
  );
}

userSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  async function oneAdminOnQuery() {
    if (!setsAdminRole(this.getUpdate())) return;
    // Only the local admin-transfer script (phase 3) may pass this option.
    if (this.getOptions().allowAdminRoleChange === true) return;
    if (this.op === 'updateMany') throw secondAdmin();
    // Any admin outside the documents this query targets blocks the write.
    const other = await this.model.exists({ $and: [{ role: 'admin' }, { $nor: [this.getFilter()] }] });
    if (other) throw secondAdmin();
  },
);

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
    status: user.status || 'active',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
