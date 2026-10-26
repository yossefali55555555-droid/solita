import mongoose from 'mongoose';
import { DELIVERY_STATUSES, FAILURE_REASONS } from '../constants/statuses.js';

const { ObjectId } = mongoose.Schema.Types;

const moneyField = {
  type: Number,
  default: 0,
  validate: { validator: Number.isInteger, message: 'Money must be stored as integer piasters' },
};

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 200, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    phoneNormalized: { type: String, maxlength: 40, default: '' },
    government: { type: String, trim: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 1000, default: '' },
    email: { type: String, trim: true, maxlength: 200 },
    alternativePhone: { type: String, trim: true, maxlength: 40 },
    area: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

const itemOptionSchema = new mongoose.Schema(
  { name: { type: String, maxlength: 100 }, value: { type: String, maxlength: 200 } },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    externalId: { type: String, maxlength: 100 },
    productId: { type: String, maxlength: 100 },
    variantId: { type: String, maxlength: 100 },
    name: { type: String, required: true, maxlength: 300 },
    sku: { type: String, maxlength: 120 },
    quantity: { type: Number, required: true, min: 0 },
    price: moneyField, // unit price, piasters
    options: { type: [itemOptionSchema], default: undefined },
  },
  { _id: false },
);

const deliveryAttemptSchema = new mongoose.Schema(
  {
    courier: { type: ObjectId, ref: 'User', required: true },
    outcome: { type: String, enum: ['failed'], default: 'failed' },
    reason: { type: String, enum: FAILURE_REASONS, required: true },
    note: { type: String, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const orderSchema = new mongoose.Schema(
  {
    easyOrdersId: { type: String, required: true, trim: true, maxlength: 100 },
    storeId: { type: String, maxlength: 100 },

    customer: { type: customerSchema, default: () => ({}) },
    items: { type: [itemSchema], default: [] },

    // All money values are integer piasters (1 EGP = 100).
    subtotal: moneyField,
    shippingFee: moneyField,
    discount: moneyField,
    totalAmount: moneyField,
    currency: { type: String, default: 'EGP', maxlength: 3 },
    paymentMethod: { type: String, maxlength: 60 },
    paymentStatus: { type: String, enum: ['unpaid', 'paid', 'failed', 'refunded'], default: 'unpaid' },
    paymentRefId: { type: String, maxlength: 200 },

    // ---- Source (EasyOrders) controlled ----
    sourceStatus: { type: String, maxlength: 60 },
    sourceStatusUpdatedAt: { type: Date },
    sourceStatusNeedsVerification: { type: Boolean, default: false },
    sourceCreatedAt: { type: Date },
    sourceUpdatedAt: { type: Date },
    lastSyncedFromSourceAt: { type: Date },

    // ---- Internal (Solita) controlled; never overwritten by source updates ----
    deliveryStatus: { type: String, enum: DELIVERY_STATUSES, default: 'new', required: true },
    assignedTo: { type: ObjectId, ref: 'User', default: null },
    assignedBy: { type: ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    deliveryAttempts: { type: [deliveryAttemptSchema], default: [] },
    currentReview: { type: ObjectId, ref: 'DeliveryReview', default: null },
    deliveredAt: { type: Date },
    cancellation: {
      reason: { type: String, maxlength: 1000 },
      by: { type: ObjectId, ref: 'User' },
      at: { type: Date },
      source: { type: String, enum: ['admin', 'easyorders'] },
    },
    sourceConflict: {
      active: { type: Boolean, default: false },
      message: { type: String, maxlength: 500 },
      at: { type: Date },
    },

    // ---- Outbound synchronization summary ----
    sync: {
      state: { type: String, enum: ['none', 'pending', 'synced', 'failed'], default: 'none' },
      lastPushedStatus: { type: String, maxlength: 60 },
      lastPushedAt: { type: Date },
      lastError: { type: String, maxlength: 500 },
    },
    lastSyncedToSourceAt: { type: Date },

    // ---- Cash on delivery ----
    cod: {
      isCod: { type: Boolean, default: false },
      expectedAmount: moneyField,
      declaredAmount: { type: Number, default: null },
      declaredAt: { type: Date },
      declaredBy: { type: ObjectId, ref: 'User' },
      remittance: { type: ObjectId, ref: 'CashRemittance', default: null },
    },

    // Demo records (MOCK_MODE only) are flagged so they are never mistaken for real data.
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

orderSchema.index({ easyOrdersId: 1 }, { unique: true });
orderSchema.index({ deliveryStatus: 1, createdAt: -1 });
orderSchema.index({ sourceStatus: 1, createdAt: -1 });
orderSchema.index({ assignedTo: 1, deliveryStatus: 1 });
orderSchema.index({ 'customer.phoneNormalized': 1 });
orderSchema.index({ sourceCreatedAt: -1 });
orderSchema.index({ 'cod.remittance': 1, assignedTo: 1 });

export const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
