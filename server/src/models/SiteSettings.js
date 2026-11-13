import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Storefront settings, one document (key "site"). `settings` is validated by
 * the Zod schema in validators/siteSettings.js on every write, and merged
 * with the defaults on every read, so a field added later always has a value.
 */
const siteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 50 },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    revision: { type: Number, default: 0 },
    updatedBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);

siteSettingsSchema.index({ key: 1 }, { unique: true });

export const SiteSettings =
  mongoose.models.SiteSettings || mongoose.model('SiteSettings', siteSettingsSchema, 'site_settings');
