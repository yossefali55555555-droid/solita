import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A "missed order" from the EasyOrders dashboard (#/missed-orders): a customer
 * who pressed order and hit a problem (wrong data, failed OTP, ...). EasyOrders
 * has no API for them, so rows arrive by importing the page's export file.
 * `key` is a hash of phone + date + reason, so importing the same file again
 * never duplicates a row and never resets what the team already did to it.
 */
const missedOrderSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 64 },
    name: { type: String, trim: true, maxlength: 200, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    phoneNormalized: { type: String, maxlength: 40, default: '' },
    reason: { type: String, trim: true, maxlength: 200, default: '' },
    eoStatus: { type: String, trim: true, maxlength: 60, default: '' },
    eoDate: { type: Date, required: true },
    importedAt: { type: Date, default: Date.now },

    contactedAt: { type: Date, default: null },
    contactedBy: { type: ObjectId, ref: 'User', default: null },
    dismissedAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    isTest: { type: Boolean, default: false },
  },
  { timestamps: false, versionKey: false },
);

missedOrderSchema.index({ key: 1 }, { unique: true });
missedOrderSchema.index({ eoDate: -1 });
missedOrderSchema.index({ phoneNormalized: 1 });

export const MissedOrder = mongoose.models.MissedOrder || mongoose.model('MissedOrder', missedOrderSchema, 'missed_orders');
