import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Append-only audit trail. Events reference an order and/or another subject
 * (a remittance or a user account). Update and delete operations are blocked
 * at the model level.
 */
const orderEventSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: 'Order', default: null },
    remittance: { type: ObjectId, ref: 'CashRemittance', default: null },
    subjectUser: { type: ObjectId, ref: 'User', default: null },
    type: { type: String, required: true, maxlength: 80 },
    actor: {
      kind: { type: String, enum: ['user', 'easyorders', 'system'], required: true },
      user: { type: ObjectId, ref: 'User' },
      role: { type: String, maxlength: 20 },
      name: { type: String, maxlength: 120 },
    },
    previous: { type: Mixed },
    next: { type: Mixed },
    reason: { type: String, maxlength: 1000 },
    syncOutcome: { type: String, maxlength: 60 },
    metadata: { type: Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

orderEventSchema.index({ order: 1, createdAt: -1 });
orderEventSchema.index({ remittance: 1, createdAt: -1 });
orderEventSchema.index({ subjectUser: 1, createdAt: -1 });
orderEventSchema.index({ type: 1, createdAt: -1 });

const blocked = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];
orderEventSchema.pre(blocked, function blockMutation() {
  throw new Error('OrderEvent is append-only');
});
orderEventSchema.pre('save', function blockResave() {
  if (!this.isNew) throw new Error('OrderEvent is append-only');
});

export const OrderEvent = mongoose.models.OrderEvent || mongoose.model('OrderEvent', orderEventSchema);
