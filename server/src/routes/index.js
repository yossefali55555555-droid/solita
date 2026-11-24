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
import { pageStatsQuery, importMissedBody, listMissedQuery, updateMissedBody, bulkMissedBody, addCouponsBody, assignCouponBody, couponDatesBody, couponSettingsBody, importCouponsBody, listCartsQuery, updateFounderBody } from '../validators/storefront.js';
import * as couponCtl from '../controllers/couponController.js';
import { siteSettingsSchema } from '../validators/siteSettings.js';
import { adminOnly, staffRouter, tagRouter } from '../middleware/permissions.js';
import { STAFF_ROLES } from '../constants/statuses.js';

export function buildRouter() {
  const api = tagRouter(Router(), 'api');

  // ---------------- Authentication ----------------
  const authRoutes = tagRouter(Router(), 'auth');
  authRoutes.get('/csrf', auth.csrf);
  authRoutes.post('/login', loginRateLimiter(), validate({ body: s.loginBody }), auth.postLogin);
  authRoutes.post('/logout', auth.postLogout);
  authRoutes.get('/me', requireAuth, auth.getMe);
  authRoutes.post('/change-password', requireAuth, validate({ body: s.changePasswordBody }), auth.postChangePassword);
  authRoutes.get('/notifications', requireAuth, auth.getNotifications);
  authRoutes.post('/notifications/read', requireAuth, auth.postNotificationsRead);
  api.use('/auth', authRoutes);

  // ---------------- Webhooks (secret header, no cookies/CSRF) ----------------
  const hooks = tagRouter(Router(), 'webhooks');
  hooks.use(webhookRateLimiter());
  hooks.post('/easyorders/orders', webhook.ordersWebhook);
  hooks.post('/easyorders/status', webhook.statusWebhook);
  api.use('/webhooks', hooks);

  // ---------------- Cron (Bearer CRON_SECRET) ----------------
  api.get('/cron/process', webhook.cronProcess);

  // ---------------- Admin ----------------
  // Every route starts with its permission metadata (middleware/permissions.js).
  // Phase 1: all routes are adminOnly(...) with the planned moderator
  // permission recorded as arguments (SPEC table a). Behaviour is unchanged
  // for admins; moderators are refused on every route until phase 2.
  const a = staffRouter();
  a.use(requireRole(...STAFF_ROLES), requirePasswordUpToDate);
  const id = validate({ params: idParams });

  a.get('/overview', adminOnly('dashboard', 'view'), admin.overview);

  a.post('/couriers', adminOnly('couriers', 'edit'), validate({ body: s.createCourierBody }), admin.createCourier);
  a.get('/couriers', adminOnly('couriers', 'view'), validate({ query: s.listCouriersQuery }), admin.listCouriers);
  a.get('/couriers-brief', adminOnly(['orders', 'couriers'], 'view'), admin.listCouriersBrief);
  a.get('/couriers/:id', adminOnly('couriers', 'view'), id, admin.getCourier);
  a.patch('/couriers/:id', adminOnly('couriers', 'edit'), validate({ params: idParams, body: s.updateCourierBody }), admin.updateCourier);
  a.patch('/couriers/:id/active', adminOnly('couriers', 'edit'), validate({ params: idParams, body: s.courierActiveBody }), admin.setCourierActive);
  a.post('/couriers/:id/password', adminOnly('couriers', 'edit', { dangerous: 'resetCourierPassword' }), validate({ params: idParams, body: s.resetPasswordBody }), admin.resetCourierPassword);
  a.get('/couriers/:id/events', adminOnly('couriers', 'view'), id, admin.courierEvents);

  a.get('/orders', adminOnly('orders', 'view'), validate({ query: s.listOrdersQuery }), admin.listOrders);
  a.get('/orders/cleared/count', adminOnly('orders', 'view'), admin.clearedOrdersCount);
  a.post('/orders/bulk', adminOnly('orders', 'edit'), validate({ body: s.bulkOrdersBody }), admin.bulkOrders);
  a.post('/orders/:id/notes', adminOnly('orders', 'edit'), validate({ params: idParams, body: s.noteBody }), admin.addOrderNoteCtl);
  a.post('/orders/:id/notes/:noteId/retry', adminOnly('orders', 'edit'), id, admin.retryOrderNoteCtl);
  a.post('/orders/:id/test', adminOnly('orders', 'edit', { dangerous: 'markTest' }), validate({ params: idParams, body: s.testFlagBody }), admin.setOrderTest);
  a.post('/orders/clear', adminOnly('orders', 'edit', { dangerous: 'clearOrders' }), validate({ body: s.clearOrdersBody }), admin.clearOrders);
  a.post('/orders/restore-cleared', adminOnly('orders', 'edit', { dangerous: 'clearOrders' }), admin.restoreClearedOrders);
  a.get('/orders/:id', adminOnly('orders', 'view'), id, admin.getOrder);
  a.patch('/orders/:id/assignment', adminOnly('orders', 'edit'), validate({ params: idParams, body: s.assignmentBody }), admin.assignOrder);
  a.patch('/orders/:id/status', adminOnly('orders', 'edit', { dangerous: 'changeOrderStatus' }), validate({ params: idParams, body: s.adminStatusBody }), admin.changeOrderStatus);
  a.post('/orders/:id/conflict/acknowledge', adminOnly('orders', 'edit'), id, admin.acknowledgeConflict);
  a.get('/orders/:id/events', adminOnly('orders', 'view'), id, admin.orderEvents);

  a.get('/delivery-reviews', adminOnly('reviews', 'view'), validate({ query: s.listReviewsQuery }), admin.listReviews);
  a.get('/delivery-reviews/:id', adminOnly('reviews', 'view'), id, admin.getReview);
  a.post('/delivery-reviews/:id/approve', adminOnly('reviews', 'edit'), id, admin.approveReview);
  a.post('/delivery-reviews/:id/reject', adminOnly('reviews', 'edit'), validate({ params: idParams, body: s.rejectReviewBody }), admin.rejectReview);

  a.get('/sync/failures', adminOnly('sync', 'view'), validate({ query: s.listSyncFailuresQuery }), admin.syncFailures);
  a.post('/sync/process-due', adminOnly('sync', 'edit'), admin.processDue);
  a.post('/system/init-db', adminOnly(), admin.initDb);
  a.get('/easyorders/poll', adminOnly('sync', 'view'), admin.pollStatus);
  a.post('/easyorders/poll', adminOnly('sync', 'edit'), admin.pollNow);
  a.post('/easyorders/import', adminOnly('sync', 'edit'), validate({ body: s.importOrderBody }), admin.importEasyOrdersOrder);
  a.post('/sync/webhooks/:id/retry', adminOnly('sync', 'edit'), id, admin.retryWebhook);
  a.post('/sync/:id/retry', adminOnly('sync', 'edit'), id, admin.retrySync);

  a.get('/cash/overview', adminOnly('cash', 'view'), admin.cashOverview);
  a.post('/cash/reset', adminOnly('cash', 'edit', { dangerous: 'resetCash' }), validate({ body: s.cashResetBody }), admin.resetCash);
  a.post('/cash/reset/undo', adminOnly('cash', 'edit', { dangerous: 'resetCash' }), admin.undoCashReset);
  a.get('/cash/eligible-orders', adminOnly('cash', 'view'), validate({ query: s.eligibleOrdersQuery }), admin.eligibleOrders);
  a.get('/cash/remittances', adminOnly('cash', 'view'), validate({ query: s.listRemittancesQuery }), admin.listRemittances);
  a.post('/cash/remittances', adminOnly('cash', 'edit'), validate({ body: s.adminCreateRemittanceBody }), admin.createRemittance);
  a.get('/cash/remittances/:id', adminOnly('cash', 'view'), id, admin.getRemittance);
  a.get('/cash/remittances/:id/events', adminOnly('cash', 'view'), id, admin.remittanceEvents);
  a.post('/cash/remittances/:id/receive', adminOnly('cash', 'edit'), validate({ params: idParams, body: s.receiveRemittanceBody }), admin.receiveRemittance);
  a.post('/cash/remittances/:id/verify', adminOnly('cash', 'edit'), validate({ params: idParams, body: s.verifyRemittanceBody }), admin.verifyRemittance);
  a.post('/cash/remittances/:id/cancel', adminOnly('cash', 'edit'), validate({ params: idParams, body: s.cancelRemittanceBody }), admin.cancelRemittance);

  a.get('/labels', adminOnly('warehouse', 'view'), validate({ query: s.labelQueueQuery }), admin.labelQueue);
  a.get('/labels/view', adminOnly('warehouse', 'view', { fields: ['customerPhone'] }), validate({ query: s.getLabelsQuery }), admin.getLabels);
  a.post('/labels/print', adminOnly('warehouse', 'edit', { fields: ['customerPhone'] }), validate({ body: s.printLabelsBody }), admin.printLabels);
  a.post('/returns/scan', adminOnly('warehouse', 'edit'), validate({ body: s.scanBody }), admin.warehouseScan);

  a.get('/returns', adminOnly('warehouse', 'view'), validate({ query: s.listReturnsQuery }), admin.listReturns);
  a.post('/orders/:id/return', adminOnly('warehouse', 'edit'), validate({ params: idParams, body: s.confirmReturnBody }), admin.confirmReturn);

  a.get('/customers', adminOnly('customers', 'view'), validate({ query: s.listCustomersQuery }), admin.listCustomers);
  a.get('/customers/:key', adminOnly('customers', 'view'), validate({ params: s.customerKeyParams }), admin.getCustomer);

  a.get('/finance/summary', adminOnly('finance', 'view'), validate({ query: s.profitQuery }), admin.profitSummary);
  a.post('/finance/reset', adminOnly('finance', 'edit', { dangerous: 'resetFinance' }), validate({ body: s.financeResetBody }), admin.resetFinance);
  a.post('/finance/reset/undo', adminOnly('finance', 'edit', { dangerous: 'resetFinance' }), admin.undoFinanceReset);
  a.get('/finance/expenses', adminOnly('finance', 'view'), validate({ query: s.listExpensesQuery }), admin.listExpenses);
  a.post('/finance/expenses', adminOnly('finance', 'edit'), validate({ body: s.createExpenseBody }), admin.createExpense);
  a.patch('/finance/expenses/:id', adminOnly('finance', 'edit'), validate({ params: idParams, body: s.updateExpenseBody }), admin.updateExpense);
  a.post('/finance/expenses/:id/delete', adminOnly('finance', 'edit', { dangerous: 'deleteExpense' }), validate({ params: idParams, body: s.deleteExpenseBody }), admin.deleteExpense);

  a.get('/storefront/carts', adminOnly('storefront', 'view'), validate({ query: listCartsQuery }), storefront.listCarts);
  a.post('/storefront/carts/:id/contacted', adminOnly('storefront', 'edit'), id, storefront.markCartContacted);
  a.post('/storefront/carts/:id/dismiss', adminOnly('storefront', 'edit'), id, storefront.dismissCart);
  a.get('/storefront/summary', adminOnly('storefront', 'view'), storefront.behaviourSummary);
  a.get('/storefront/pages', adminOnly('storefront', 'view'), validate({ query: pageStatsQuery }), storefront.getPageStats);
  a.get('/missed-orders', adminOnly('missedOrders', 'view'), validate({ query: listMissedQuery }), storefront.listMissed);
  a.post('/missed-orders/import', adminOnly('missedOrders', 'edit'), validate({ body: importMissedBody }), storefront.importMissed);
  a.post('/missed-orders/bulk', adminOnly('missedOrders', 'edit'), validate({ body: bulkMissedBody }), storefront.bulkMissed);
  a.patch('/missed-orders/:id', adminOnly('missedOrders', 'edit'), validate({ params: idParams, body: updateMissedBody }), storefront.updateMissed);
  a.get('/coupons', adminOnly('coupons', 'view'), couponCtl.listCoupons);
  a.post('/coupons', adminOnly('coupons', 'edit'), validate({ body: addCouponsBody }), couponCtl.addCoupons);
  a.get('/coupons/attempts', adminOnly('coupons', 'view'), couponCtl.listAttempts);
  a.post('/coupons/import', adminOnly('coupons', 'edit'), validate({ body: importCouponsBody }), couponCtl.importCoupons);
  a.patch('/coupons/:id/dates', adminOnly('coupons', 'edit'), validate({ params: idParams, body: couponDatesBody }), couponCtl.editDates);
  a.post('/coupons/:id/undo', adminOnly('coupons', 'edit'), id, couponCtl.undoChange);
  a.patch('/coupons/:id/settings', adminOnly('coupons', 'edit'), validate({ params: idParams, body: couponSettingsBody }), couponCtl.updateSettings);
  a.post('/coupons/:id/assign', adminOnly('coupons', 'edit'), validate({ params: idParams, body: assignCouponBody }), couponCtl.assignCoupon);
  a.post('/coupons/:id/release', adminOnly('coupons', 'edit'), id, couponCtl.releaseCoupon);
  a.post('/coupons/:id/sent', adminOnly('coupons', 'edit', { fields: ['customerPhone'] }), id, couponCtl.couponSent);
  a.post('/orders/:id/coupon', adminOnly('coupons', 'edit', { fields: ['customerPhone'], also: { orders: 'view' } }), id, couponCtl.orderCoupon);
  a.post('/orders/:id/confirmation-sent', adminOnly('orders', 'edit', { fields: ['customerPhone'] }), id, couponCtl.orderConfirmationSent);
  a.get('/founders', adminOnly('founders', 'view'), storefront.listFounders);
  a.patch('/founders/:id', adminOnly('founders', 'edit'), validate({ params: idParams, body: updateFounderBody }), storefront.updateFounder);
  a.get('/site-settings', adminOnly('siteSettings', 'view'), storefront.getSiteSettings);
  a.patch('/site-settings', adminOnly('siteSettings', 'edit'), validate({ body: siteSettingsSchema }), storefront.updateSiteSettings);
  api.use('/admin', a);

  // ---------------- Courier ----------------
  const c = tagRouter(Router(), 'courier');
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
