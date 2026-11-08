import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Small application-wide settings documents, one per `key`.
 *
 * key "cash": `resetAt` is the cash-page reset marker. Cash figures on the
 * admin cash page only count deliveries and remittances after it. Nothing is
 * deleted, so clearing the marker brings the old figures back.
 *
 * key "finance": the same kind of marker for the profits & expenses page.
 */
const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 100 },
    resetAt: { type: Date, default: null },
    resetBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

appSettingSchema.index({ key: 1 }, { unique: true });

export const AppSetting = mongoose.models.AppSetting || mongoose.model('AppSetting', appSettingSchema);
