import * as coupons from '../services/couponService.js';
import { Order } from '../models/index.js';
import { notFound } from '../utils/errors.js';

export async function listCoupons(req, res) {
  res.json(await coupons.listCoupons(req.viewer));
}

export async function addCoupons(req, res) {
  res.status(201).json(await coupons.addToPool(req.valid.body.codes));
}

export async function listAttempts(req, res) {
  res.json({ items: await coupons.listAttempts({}, req.viewer) });
}

export async function importCoupons(req, res) {
  res.json(await coupons.importFromEasyOrders(req.valid.body.coupons));
}

export async function updateSettings(req, res) {
  res.json({ coupon: await coupons.updateCouponSettings(req.valid.params.id, req.valid.body, req.user) });
}

// POST /api/coupon-sync/exchange (secret header): the bookmarklet's round trip.
export async function syncExchange(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(await coupons.syncExchange(req.valid.body.coupons));
}

export async function editDates(req, res) {
  res.json({ coupon: await coupons.editDates(req.valid.params.id, req.valid.body, req.user) });
}

export async function undoChange(req, res) {
  res.json({ coupon: await coupons.undoLastChange(req.valid.params.id) });
}

export async function assignCoupon(req, res) {
  res.json({ coupon: await coupons.assignManually(req.valid.params.id, req.valid.body, req.user, req.viewer) });
}

export async function releaseCoupon(req, res) {
  res.json({ coupon: await coupons.releaseCoupon(req.valid.params.id, req.user) });
}

export async function couponSent(req, res) {
  res.json({ coupon: await coupons.markCouponSent(req.valid.params.id, req.user) });
}

// The coupon button on an order row: assigns a code if the customer has none.
export async function orderCoupon(req, res) {
  const row = await coupons.couponForOrder(req.valid.params.id);
  res.json({ coupon: { _id: row._id, code: row.code, sentAt: row.sentAt } });
}

// The confirmation button on an order row was pressed (message opened in WhatsApp).
export async function orderConfirmationSent(req, res) {
  const order = await Order.findByIdAndUpdate(
    req.valid.params.id,
    { $set: { confirmationSentAt: new Date(), confirmationSentBy: req.user._id } },
    { returnDocument: 'after' },
  ).select('confirmationSentAt');
  if (!order) throw notFound('الطلب غير موجود');
  res.json({ confirmationSentAt: order.confirmationSentAt });
}

// POST /api/public/coupon-check
export async function publicCouponCheck(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(await coupons.checkCouponForStorefront(req.valid.body));
}
