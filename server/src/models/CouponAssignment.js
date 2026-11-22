import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A discount coupon created in EasyOrders and tied to one customer phone.
 * A code with no phone is still in the pool (not given to anyone yet).
 * Codes are stored lowercase (EasyOrders matches codes case-insensitively).
 */
const couponAssignmentSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    // Insertion order: the lowest unassigned `seq` goes to the next customer.
    seq: { type: Number, required: true },
    // Customer-bound: only the assigned phone may use it. Unbound coupons are left to EasyOrders.
    bound: { type: Boolean, default: true },
    // Full coupon object as EasyOrders has it (all its settings), refreshed by the sync.
    eo: { type: mongoose.Schema.Types.Mixed, default: null },
    eoSyncedAt: { type: Date, default: null },
    // Edits made here that EasyOrders does not have yet (EasyOrders field names). Applied by the next sync.
    pendingEo: { type: mongoose.Schema.Types.Mixed, default: null },
    phoneNormalized: { type: String, default: null, maxlength: 40 },
    customerName: { type: String, trim: true, maxlength: 200, default: '' },
    order: { type: ObjectId, ref: 'Order', default: null },
    assignedAt: { type: Date, default: null },
    // Valid for exactly 365 days from assignment (the customer received the order / the code).
    expiresAt: { type: Date, default: null },
    assignedVia: { type: String, enum: ['auto', 'manual', 'order', 'import'], default: undefined },
    sentAt: { type: Date, default: null },
    sentBy: { type: ObjectId, ref: 'User', default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    // Every change the owner (or the system) made, with the values it replaced, so the last ones can be undone.
    history: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            by: { type: ObjectId, ref: 'User', default: null },
            action: { type: String, maxlength: 40 },
            before: { type: mongoose.Schema.Types.Mixed, default: {} },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

couponAssignmentSchema.index({ code: 1 }, { unique: true });
couponAssignmentSchema.index({ seq: 1 });
// One code per customer phone; the pool (null phone) is not constrained.
couponAssignmentSchema.index(
  { phoneNormalized: 1 },
  { unique: true, partialFilterExpression: { phoneNormalized: { $type: 'string' } } },
);

export const COUPON_VALID_DAYS = 365;

export const CouponAssignment =
  mongoose.models.CouponAssignment || mongoose.model('CouponAssignment', couponAssignmentSchema, 'coupon_assignments');
