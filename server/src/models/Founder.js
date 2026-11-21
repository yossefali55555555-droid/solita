import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * "أوائل سوليتا": the first N customers whose order was delivered.
 * A founder keeps a personal EasyOrders coupon (the member discount, valid
 * for 12 months from joining) and a friend coupon (10% for a friend; every
 * order that uses it is an extra chance in the draw). Both coupons are
 * created in EasyOrders and only recorded here.
 */
export const FOUNDER_BENEFIT_MONTHS = 12;

const founderSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1 },
    name: { type: String, trim: true, maxlength: 200, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    phoneNormalized: { type: String, required: true, maxlength: 40 },
    order: { type: ObjectId, ref: 'Order', required: true },
    joinedAt: { type: Date, required: true },
    benefitUntil: { type: Date, required: true },
    // Lowercase EasyOrders coupon codes, entered by the owner after creating them.
    personalCode: { type: String, trim: true, lowercase: true, maxlength: 60, default: '' },
    friendCode: { type: String, trim: true, lowercase: true, maxlength: 60, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true },
);

founderSchema.index({ number: 1 }, { unique: true });
founderSchema.index({ phoneNormalized: 1 }, { unique: true });
founderSchema.index({ order: 1 }, { unique: true });

export const Founder = mongoose.models.Founder || mongoose.model('Founder', founderSchema, 'founders');
