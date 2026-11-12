import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const CART_STATUSES = ['open', 'contacted', 'converted', 'expired'];
/** Carts are deleted this long after their last activity (privacy: phone numbers do not stay forever). */
export const CART_RETENTION_DAYS = 90;
/** An open/contacted cart with no activity for this long becomes "expired". */
export const CART_EXPIRE_AFTER_DAYS = 30;
/** An EasyOrders order with the same phone converts carts active within this window. */
export const CART_PHONE_MATCH_DAYS = 14;

const cartItemSchema = new mongoose.Schema(
  {
    slug: { type: String, maxlength: 200, required: true },
    sku: { type: String, maxlength: 100, default: '' },
    name: { type: String, maxlength: 200, default: '' },
    size: { type: String, maxlength: 20, default: '' },
    qty: { type: Number, min: 1, max: 99, required: true },
    price: { type: Number, min: 0, default: 0 }, // integer piasters, per unit
  },
  { _id: false },
);

/**
 * A storefront cart reported by the site itself (EasyOrders does not record
 * abandoned carts). One *active* cart per visitor (active = open or
 * contacted); converted / expired carts are history. A new cart starts when
 * the visitor adds items again.
 */
const storefrontCartSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, maxlength: 64 },
    active: { type: Boolean, default: true },
    status: { type: String, enum: CART_STATUSES, default: 'open' },
    items: { type: [cartItemSchema], default: [] },
    itemsCount: { type: Number, default: 0 },
    value: { type: Number, default: 0 }, // integer piasters
    customer: {
      name: { type: String, maxlength: 120, default: '' },
      phone: { type: String, maxlength: 40, default: '' },
      phoneNormalized: { type: String, maxlength: 40, default: '' },
    },
    lastActivityAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    contactedAt: { type: Date, default: null },
    contactedBy: { type: ObjectId, ref: 'User', default: null },
    contactCount: { type: Number, default: 0 },
    dismissedAt: { type: Date, default: null },
    dismissedBy: { type: ObjectId, ref: 'User', default: null },
    convertedAt: { type: Date, default: null },
    convertedVia: { type: String, enum: ['order_placed', 'phone_match', null], default: null },
    convertedOrderId: { type: String, maxlength: 100, default: null }, // EasyOrders order id
    convertedShortId: { type: Number, default: null },
    convertedOrder: { type: ObjectId, ref: 'Order', default: null },
  },
  { timestamps: true },
);

storefrontCartSchema.index({ visitorId: 1 }, { unique: true, partialFilterExpression: { active: true } });
storefrontCartSchema.index({ active: 1, lastActivityAt: -1 });
storefrontCartSchema.index({ 'customer.phoneNormalized': 1, active: 1 });
storefrontCartSchema.index({ convertedOrderId: 1 }, { sparse: true });
storefrontCartSchema.index({ lastActivityAt: 1 }, { expireAfterSeconds: CART_RETENTION_DAYS * 24 * 60 * 60 });

export const StorefrontCart =
  mongoose.models.StorefrontCart || mongoose.model('StorefrontCart', storefrontCartSchema, 'storefront_carts');
