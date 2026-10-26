import mongoose from 'mongoose';
import { REMITTANCE_STATUSES } from '../constants/statuses.js';

const { ObjectId } = mongoose.Schema.Types;

const intMoney = {
  type: Number,
  validate: { validator: (v) => v === null || v === undefined || Number.isInteger(v), message: 'Money must be integer piasters' },
};

/**
 * Cash handed over by a courier for a set of delivered COD orders.
 * Delivery completion alone never marks cash as handed over.
 */
const cashRemittanceSchema = new mongoose.Schema(
  {
    courier: { type: ObjectId, ref: 'User', required: true },
    orders: [{ type: ObjectId, ref: 'Order', required: true }],
    expectedAmount: { ...intMoney, required: true },
    declaredAmount: { ...intMoney, default: null }, // courier declaration
    handedOverAmount: { ...intMoney, default: null }, // actual cash received by admin
    verifiedAmount: { ...intMoney, default: null },
    difference: { ...intMoney, default: null }, // verified (or handed over) - expected
    status: { type: String, enum: REMITTANCE_STATUSES, default: 'declared' },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    receivedBy: { type: ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: null },
    verifiedBy: { type: ObjectId, ref: 'User', default: null },
    reconciledAt: { type: Date, default: null },
    cancelledBy: { type: ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true },
);

cashRemittanceSchema.index({ courier: 1, createdAt: -1 });
cashRemittanceSchema.index({ status: 1, createdAt: -1 });
cashRemittanceSchema.index({ orders: 1 });

export const CashRemittance =
  mongoose.models.CashRemittance || mongoose.model('CashRemittance', cashRemittanceSchema);
