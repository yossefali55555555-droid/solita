import { Router } from 'express';
import { requireAuth, requirePasswordUpToDate, requireRole } from '../middleware/auth.js';
import { loginRateLimiter, webhookRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/common.js';
import * as s from '../validators/schemas.js';
import * as auth from '../controllers/authController.js';
import * as admin from '../controllers/adminController.js';
import * as courier from '../controllers/courierController.js';
import * as webhook from '../controllers/webhookController.js';

export function buildRouter() {
  const api = Router();

  // ---------------- Authentication ----------------
  const authRoutes = Router();
  authRoutes.get('/csrf', auth.csrf);
  authRoutes.post('/login', loginRateLimiter(), validate({ body: s.loginBody }), auth.postLogin);
  authRoutes.post('/logout', auth.postLogout);
  authRoutes.get('/me', requireAuth, auth.getMe);
  authRoutes.post('/change-password', requireAuth, validate({ body: s.changePasswordBody }), auth.postChangePassword);
  authRoutes.get('/notifications', requireAuth, auth.getNotifications);
  authRoutes.post('/notifications/read', requireAuth, auth.postNotificationsRead);
  api.use('/auth', authRoutes);

  // ---------------- Webhooks (secret header, no cookies/CSRF) ----------------
  const hooks = Router();
  hooks.use(webhookRateLimiter());
  hooks.post('/easyorders/orders', webhook.ordersWebhook);
  hooks.post('/easyorders/status', webhook.statusWebhook);
  api.use('/webhooks', hooks);

  // ---------------- Cron (Bearer CRON_SECRET) ----------------
  api.get('/cron/process', webhook.cronProcess);

  // ---------------- Admin ----------------
  const a = Router();
  a.use(requireRole('admin'), requirePasswordUpToDate);
  const id = validate({ params: idParams });

  a.get('/overview', admin.overview);

  a.post('/couriers', validate({ body: s.createCourierBody }), admin.createCourier);
  a.get('/couriers', validate({ query: s.listCouriersQuery }), admin.listCouriers);
  a.get('/couriers-brief', admin.listCouriersBrief);
  a.get('/couriers/:id', id, admin.getCourier);
  a.patch('/couriers/:id', validate({ params: idParams, body: s.updateCourierBody }), admin.updateCourier);
  a.patch('/couriers/:id/active', validate({ params: idParams, body: s.courierActiveBody }), admin.setCourierActive);
  a.post('/couriers/:id/password', validate({ params: idParams, body: s.resetPasswordBody }), admin.resetCourierPassword);
  a.get('/couriers/:id/events', id, admin.courierEvents);

  a.get('/orders', validate({ query: s.listOrdersQuery }), admin.listOrders);
  a.get('/orders/:id', id, admin.getOrder);
  a.patch('/orders/:id/assignment', validate({ params: idParams, body: s.assignmentBody }), admin.assignOrder);
  a.patch('/orders/:id/status', validate({ params: idParams, body: s.adminStatusBody }), admin.changeOrderStatus);
  a.post('/orders/:id/conflict/acknowledge', id, admin.acknowledgeConflict);
  a.get('/orders/:id/events', id, admin.orderEvents);

  a.get('/delivery-reviews', validate({ query: s.listReviewsQuery }), admin.listReviews);
  a.get('/delivery-reviews/:id', id, admin.getReview);
  a.post('/delivery-reviews/:id/approve', id, admin.approveReview);
  a.post('/delivery-reviews/:id/reject', validate({ params: idParams, body: s.rejectReviewBody }), admin.rejectReview);

  a.get('/sync/failures', validate({ query: s.listSyncFailuresQuery }), admin.syncFailures);
  a.post('/sync/process-due', admin.processDue);
  a.get('/easyorders/poll', admin.pollStatus);
  a.post('/easyorders/poll', admin.pollNow);
  a.post('/easyorders/import', validate({ body: s.importOrderBody }), admin.importEasyOrdersOrder);
  a.post('/sync/webhooks/:id/retry', id, admin.retryWebhook);
  a.post('/sync/:id/retry', id, admin.retrySync);

  a.get('/cash/overview', admin.cashOverview);
  a.get('/cash/eligible-orders', validate({ query: s.eligibleOrdersQuery }), admin.eligibleOrders);
  a.get('/cash/remittances', validate({ query: s.listRemittancesQuery }), admin.listRemittances);
  a.post('/cash/remittances', validate({ body: s.adminCreateRemittanceBody }), admin.createRemittance);
  a.get('/cash/remittances/:id', id, admin.getRemittance);
  a.get('/cash/remittances/:id/events', id, admin.remittanceEvents);
  a.post('/cash/remittances/:id/receive', validate({ params: idParams, body: s.receiveRemittanceBody }), admin.receiveRemittance);
  a.post('/cash/remittances/:id/verify', validate({ params: idParams, body: s.verifyRemittanceBody }), admin.verifyRemittance);
  a.post('/cash/remittances/:id/cancel', validate({ params: idParams, body: s.cancelRemittanceBody }), admin.cancelRemittance);
  api.use('/admin', a);

  // ---------------- Courier ----------------
  const c = Router();
  c.use(requireRole('courier'), requirePasswordUpToDate);
  c.get('/orders', validate({ query: s.courierOrdersQuery }), courier.listOrders);
  c.get('/orders/:id', validate({ params: idParams }), courier.getOrder);
  c.patch('/orders/:id/status', validate({ params: idParams, body: s.courierStatusBody }), courier.updateStatus);
  c.post('/orders/:id/delivery-report', validate({ params: idParams, body: s.deliveryReportBody }), courier.deliveryReport);
  c.get('/cash', courier.cashSummary);
  c.post('/cash/remittances', validate({ body: s.courierDeclareRemittanceBody }), courier.declareRemittance);
  c.get('/cash/remittances/:id', validate({ params: idParams }), courier.getRemittance);
  api.use('/courier', c);

  return api;
}
