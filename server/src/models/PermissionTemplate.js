import mongoose from 'mongoose';
import { DANGEROUS_KEYS, FIELD_KEYS, LEVELS, SECTION_KEYS } from '../constants/permissions.js';

/**
 * Permission template (SPEC (ب)). An account copies its template when it is
 * created; editing a template never changes accounts by itself (the admin
 * previews and applies it, see templateService).
 */
const sectionsSchema = new mongoose.Schema(
  Object.fromEntries(SECTION_KEYS.map((key) => [key, { type: String, enum: LEVELS }])),
  { _id: false, strict: 'throw' },
);

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    sections: { type: sectionsSchema, default: () => ({}) },
    dangerous: { type: [{ type: String, enum: DANGEROUS_KEYS }], default: [] },
    fields: { type: [{ type: String, enum: FIELD_KEYS }], default: [] },
    isDefault: { type: Boolean, default: false },
    revision: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

templateSchema.index({ name: 1 }, { unique: true });

export const PermissionTemplate =
  mongoose.models.PermissionTemplate || mongoose.model('PermissionTemplate', templateSchema);
