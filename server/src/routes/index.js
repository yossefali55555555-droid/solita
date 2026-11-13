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
import * as storefront from '../controllers/storefrontController.js';
import { listCartsQuery } from '../validators/storefront.js';
import { siteSettingsSchema } from '../validators/siteSettings.js';

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
  a.get('/orders/cleared/count', admin.clearedOrdersCount);
  a.post('/orders/clear', validate({ body: s.clearOrdersBody }), admin.clearOrders);
  a.post('/orders/restore-cleared', admin.restoreClearedOrders);
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
  a.post('/cash/reset', validate({ body: s.cashResetBody }), admin.resetCash);
  a.post('/cash/reset/undo', admin.undoCashReset);
  a.get('/cash/eligible-orders', validate({ query: s.eligibleOrdersQuery }), admin.eligibleOrders);
  a.get('/cash/remittances', validate({ query: s.listRemittancesQuery }), admin.listRemittances);
  a.post('/cash/remittances', validate({ body: s.adminCreateRemittanceBody }), admin.createRemittance);
  a.get('/cash/remittances/:id', id, admin.getRemittance);
  a.get('/cash/remittances/:id/events', id, admin.remittanceEvents);
  a.post('/cash/remittances/:id/receive', validate({ params: idParams, body: s.receiveRemittanceBody }), admin.receiveRemittance);
  a.post('/cash/remittances/:id/verify', validate({ params: idParams, body: s.verifyRemittanceBody }), admin.verifyRemittance);
  a.post('/cash/remittances/:id/cancel', validate({ params: idParams, body: s.cancelRemittanceBody }), admin.cancelRemittance);

  a.get('/labels', validate({ query: s.labelQueueQuery }), admin.labelQueue);
  a.get('/labels/view', validate({ query: s.getLabelsQuery }), admin.getLabels);
  a.post('/labels/print', validate({ body: s.printLabelsBody }), admin.printLabels);
  a.post('/returns/scan', validate({ body: s.scanBody }), admin.warehouseScan);

  a.get('/returns', validate({ query: s.listReturnsQuery }), admin.listReturns);
  a.post('/orders/:id/return', validate({ params: idParams, body: s.confirmReturnBody }), admin.confirmReturn);

  a.get('/customers', validate({ query: s.listCustomersQuery }), admin.listCustomers);
  a.get('/customers/:key', validate({ params: s.customerKeyParams }), admin.getCustomer);

  a.get('/finance/summary', validate({ query: s.profitQuery }), admin.profitSummary);
  a.post('/finance/reset', validate({ body: s.financeResetBody }), admin.resetFinance);
  a.post('/finance/reset/undo', admin.undoFinanceReset);
  a.get('/finance/expenses', validate({ query: s.listExpensesQuery }), admin.listExpenses);
  a.post('/finance/expenses', validate({ body: s.createExpenseBody }), admin.createExpense);
  a.patch('/finance/expenses/:id', validate({ params: idParams, body: s.updateExpenseBody }), admin.updateExpense);
  a.post('/finance/expenses/:id/delete', validate({ params: idParams, body: s.deleteExpenseBody }), admin.deleteExpense);

  a.get('/storefront/carts', validate({ query: listCartsQuery }), storefront.listCarts);
  a.post('/storefront/carts/:id/contacted', id, storefront.markCartContacted);
  a.post('/storefront/carts/:id/dismiss', id, storefront.dismissCart);
  a.get('/storefront/summary', storefront.behaviourSummary);
  a.get('/site-settings', storefront.getSiteSettings);
  a.patch('/site-settings', validate({ body: siteSettingsSchema }), storefront.updateSiteSettings);
  api.use('/admin', a);

  // ---------------- Courier ----------------
  const c = Router();
  c.use(requireRole('courier'), requirePasswordUpToDate);
  c.get('/orders', validate({ query: s.courierOrdersQuery }), courier.listOrders);
  c.get('/orders/:id', validate({ params: idParams }), courier.getOrder);
  c.patch('/orders/:id/status', validate({ params: idParams, body: s.courierStatusBody }), courier.updateStatus);
  c.post('/orders/:id/delivery-report', validate({ params: idParams, body: s.deliveryReportBody }), courier.deliveryReport);
  c.post('/scan', validate({ body: s.scanBody }), courier.scanParcel);
  c.get('/cash', courier.cashSummary);
  c.post('/cash/remittances', validate({ body: s.courierDeclareRemittanceBody }), courier.declareRemittance);
  c.get('/cash/remittances/:id', validate({ params: idParams }), courier.getRemittance);
  api.use('/courier', c);

  return api;
}
