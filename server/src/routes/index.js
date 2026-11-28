import { Router } from 'express';
import { requireAuth, requirePasswordUpToDate, requireRecentReauth, requireRole } from '../middleware/auth.js';
import { loginRateLimiter, mfaRateLimiter, webhookRateLimiter } from '../middleware/rateLimit.js';
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
import { sizeGuideSchema } from '../validators/sizeGuide.js';
import { adminOnly, requirePermission, staffRouter, tagRouter } from '../middleware/permissions.js';
import { STAFF_ROLES } from '../constants/statuses.js';
import * as staffCtl from '../controllers/staffController.js';
import * as st from '../validators/staff.js';
import { courierActivityLog } from '../services/activityRoutes.js';

export function buildRouter() {
  const api = tagRouter(Router(), 'api');

  // ---------------- Authentication ----------------
  const authRoutes = tagRouter(Router(), 'auth');
  authRoutes.get('/csrf', auth.csrf);
  authRoutes.post('/login', loginRateLimiter(), validate({ body: s.loginBody }), auth.postLogin);
  authRoutes.post('/logout', auth.postLogout);
  authRoutes.get('/me', requireAuth, auth.getMe);
  authRoutes.post('/change-password', requireAuth, validate({ body: s.changePasswordBody }), auth.postChangePassword);
  // Phase 4: an invited moderator sets a password with the one-time link token.
  authRoutes.post('/invite/accept', loginRateLimiter(), validate({ body: st.inviteAcceptBody }), staffCtl.acceptInvite);
  authRoutes.get('/notifications', requireAuth, auth.getNotifications);
  authRoutes.post('/notifications/read', requireAuth, auth.postNotificationsRead);
  // Phase 3: second stage of the admin sign-in, step-up, and the admin's
  // own security page (2FA, recovery codes, personal email, alerts).
  authRoutes.post('/2fa/verify', mfaRateLimiter(), validate({ body: s.mfaCodeBody }), auth.postMfaVerify);
  authRoutes.post('/step-up', requireAuth, requireRole(...STAFF_ROLES), validate({ body: s.stepUpBody }), auth.postStepUp);
  const sec = tagRouter(Router(), 'auth');
  const recent = requireRecentReauth();
  sec.use(requireRole('admin'), requirePasswordUpToDate);
  sec.get('/', auth.getSecurity);
  sec.post('/2fa/setup', recent, auth.postMfaSetup);
  sec.post('/2fa/confirm', validate({ body: s.mfaCodeBody }), auth.postMfaConfirm);
  sec.post('/recovery-codes', recent, auth.postRecoveryCodes);
  sec.post('/email', recent, validate({ body: s.securityEmailBody }), auth.postSecurityEmail);
  sec.post('/email/verify', validate({ body: s.mfaCodeBody }), auth.postSecurityEmailVerify);
  sec.post('/email/test', auth.postSecurityEmailTest);
  sec.get('/alerts', auth.getAlerts);
  sec.post('/alerts/read', auth.postAlertsRead);
  authRoutes.use('/security', sec);
  api.use('/auth', authRoutes);

  // ---------------- Webhooks (secret header, no cookies/CSRF) ----------------
  const hooks = tagRouter(Router(), 'webhooks');
  hooks.use(webhookRateLimiter());
  hooks.post('/easyorders/orders', webhook.ordersWebhook);
  hooks.post('/easyorders/status', webhook.statusWebhook);
  api.use('/webhooks', hooks);

  // ---------------- Cron (Bearer CRON_SECRET) ----------------
  api.get('/cron/process', webhook.cronProcess);
  api.get('/cron/digest', webhook.cronDigest); // end-of-day alert email (18:00 UTC)

  // ---------------- Admin ----------------
  // Every route starts with its permission metadata (middleware/permissions.js):
  // requirePermission(section, level, { dangerous, fields, also }) per SPEC
  // table (a). The administrator passes everything; a moderator needs the
  // section level, then the dangerous grant and the field grants the route
  // lists. init-db stays administrator only.
  const a = staffRouter();
  a.use(requireRole(...STAFF_ROLES), requirePasswordUpToDate);
  const id = validate({ params: idParams });

  a.get('/overview', requirePermission('dashboard', 'view'), admin.overview);
  // Tab counts: each figure is only computed for the sections the viewer may open.
  a.get('/nav-counts', requirePermission(['missedOrders', 'storefront', 'warehouse', 'reviews', 'cash'], 'view'), admin.navCounts);

  a.post('/couriers', requirePermission('couriers', 'edit'), validate({ body: s.createCourierBody }), admin.createCourier);
  a.get('/couriers', requirePermission('couriers', 'view'), validate({ query: s.listCouriersQuery }), admin.listCouriers);
  a.get('/couriers-brief', requirePermission(['orders', 'couriers'], 'view'), admin.listCouriersBrief);
  a.get('/couriers/:id', requirePermission('couriers', 'view'), id, admin.getCourier);
  a.patch('/couriers/:id', requirePermission('couriers', 'edit'), validate({ params: idParams, body: s.updateCourierBody }), admin.updateCourier);
  a.patch('/couriers/:id/active', requirePermission('couriers', 'edit'), validate({ params: idParams, body: s.courierActiveBody }), admin.setCourierActive);
  a.post('/couriers/:id/password', requirePermission('couriers', 'edit', { dangerous: 'resetCourierPassword' }), validate({ params: idParams, body: s.resetPasswordBody }), admin.resetCourierPassword);
  a.get('/couriers/:id/events', requirePermission('couriers', 'view'), id, admin.courierEvents);

  a.get('/orders', requirePermission('orders', 'view'), validate({ query: s.listOrdersQuery }), admin.listOrders);
  a.get('/orders/cleared/count', requirePermission('orders', 'view'), admin.clearedOrdersCount);
  a.post('/orders/bulk', requirePermission('orders', 'edit'), validate({ body: s.bulkOrdersBody }), admin.bulkOrders);
  a.post('/orders/:id/notes', requirePermission('orders', 'edit'), validate({ params: idParams, body: s.noteBody }), admin.addOrderNoteCtl);
  a.post('/orders/:id/notes/:noteId/retry', requirePermission('orders', 'edit'), id, admin.retryOrderNoteCtl);
  a.post('/orders/:id/test', requirePermission('orders', 'edit', { dangerous: 'markTest' }), validate({ params: idParams, body: s.testFlagBody }), admin.setOrderTest);
  a.post('/orders/clear', requirePermission('orders', 'edit', { dangerous: 'clearOrders' }), validate({ body: s.clearOrdersBody }), admin.clearOrders);
  a.post('/orders/restore-cleared', requirePermission('orders', 'edit', { dangerous: 'clearOrders', stepUp: 'recent' }), admin.restoreClearedOrders);
  a.get('/orders/:id', requirePermission('orders', 'view'), id, admin.getOrder);
  a.patch('/orders/:id/assignment', requirePermission('orders', 'edit'), validate({ params: idParams, body: s.assignmentBody }), admin.assignOrder);
  a.patch('/orders/:id/status', requirePermission('orders', 'edit', { dangerous: 'changeOrderStatus' }), validate({ params: idParams, body: s.adminStatusBody }), admin.changeOrderStatus);
  a.post('/orders/:id/conflict/acknowledge', requirePermission('orders', 'edit'), id, admin.acknowledgeConflict);
  a.get('/orders/:id/events', requirePermission('orders', 'view'), id, admin.orderEvents);

  a.get('/delivery-reviews', requirePermission('reviews', 'view'), validate({ query: s.listReviewsQuery }), admin.listReviews);
  a.get('/delivery-reviews/:id', requirePermission('reviews', 'view'), id, admin.getReview);
  a.post('/delivery-reviews/:id/approve', requirePermission('reviews', 'edit'), id, admin.approveReview);
  a.post('/delivery-reviews/:id/reject', requirePermission('reviews', 'edit'), validate({ params: idParams, body: s.rejectReviewBody }), admin.rejectReview);

  a.get('/sync/failures', requirePermission('sync', 'view'), validate({ query: s.listSyncFailuresQuery }), admin.syncFailures);
  a.post('/sync/process-due', requirePermission('sync', 'edit'), admin.processDue);
  a.post('/system/init-db', adminOnly(), admin.initDb);
  a.get('/easyorders/poll', requirePermission('sync', 'view'), admin.pollStatus);
  a.post('/easyorders/poll', requirePermission('sync', 'edit'), admin.pollNow);
  a.post('/easyorders/import', requirePermission('sync', 'edit'), validate({ body: s.importOrderBody }), admin.importEasyOrdersOrder);
  a.post('/sync/webhooks/:id/retry', requirePermission('sync', 'edit'), id, admin.retryWebhook);
  a.post('/sync/:id/retry', requirePermission('sync', 'edit'), id, admin.retrySync);

  a.get('/cash/overview', requirePermission('cash', 'view'), admin.cashOverview);
  a.post('/cash/reset', requirePermission('cash', 'edit', { dangerous: 'resetCash' }), validate({ body: s.cashResetBody }), admin.resetCash);
  a.post('/cash/reset/undo', requirePermission('cash', 'edit', { dangerous: 'resetCash', stepUp: 'recent' }), admin.undoCashReset);
  a.get('/cash/eligible-orders', requirePermission('cash', 'view'), validate({ query: s.eligibleOrdersQuery }), admin.eligibleOrders);
  a.get('/cash/remittances', requirePermission('cash', 'view'), validate({ query: s.listRemittancesQuery }), admin.listRemittances);
  a.post('/cash/remittances', requirePermission('cash', 'edit'), validate({ body: s.adminCreateRemittanceBody }), admin.createRemittance);
  a.get('/cash/remittances/:id', requirePermission('cash', 'view'), id, admin.getRemittance);
  a.get('/cash/remittances/:id/events', requirePermission('cash', 'view'), id, admin.remittanceEvents);
  a.post('/cash/remittances/:id/receive', requirePermission('cash', 'edit'), validate({ params: idParams, body: s.receiveRemittanceBody }), admin.receiveRemittance);
  a.post('/cash/remittances/:id/verify', requirePermission('cash', 'edit'), validate({ params: idParams, body: s.verifyRemittanceBody }), admin.verifyRemittance);
  a.post('/cash/remittances/:id/cancel', requirePermission('cash', 'edit'), validate({ params: idParams, body: s.cancelRemittanceBody }), admin.cancelRemittance);

  a.get('/labels', requirePermission('warehouse', 'view'), validate({ query: s.labelQueueQuery }), admin.labelQueue);
  a.get('/labels/view', requirePermission('warehouse', 'view', { fields: ['customerPhone'] }), validate({ query: s.getLabelsQuery }), admin.getLabels);
  a.post('/labels/print', requirePermission('warehouse', 'edit', { fields: ['customerPhone'] }), validate({ body: s.printLabelsBody }), admin.printLabels);
  a.post('/returns/scan', requirePermission('warehouse', 'edit'), validate({ body: s.scanBody }), admin.warehouseScan);

  a.get('/returns', requirePermission('warehouse', 'view'), validate({ query: s.listReturnsQuery }), admin.listReturns);
  a.post('/orders/:id/return', requirePermission('warehouse', 'edit'), validate({ params: idParams, body: s.confirmReturnBody }), admin.confirmReturn);

  a.get('/customers', requirePermission('customers', 'view'), validate({ query: s.listCustomersQuery }), admin.listCustomers);
  a.get('/customers/export-meta', requirePermission('customers', 'view', { fields: ['export', 'customerPhone'] }), validate({ query: s.metaExportQuery }), admin.exportMetaFile);
  a.get('/customers/:key', requirePermission('customers', 'view'), validate({ params: s.customerKeyParams }), admin.getCustomer);

  a.get('/finance/summary', requirePermission('finance', 'view'), validate({ query: s.profitQuery }), admin.profitSummary);
  a.post('/finance/reset', requirePermission('finance', 'edit', { dangerous: 'resetFinance' }), validate({ body: s.financeResetBody }), admin.resetFinance);
  a.post('/finance/reset/undo', requirePermission('finance', 'edit', { dangerous: 'resetFinance', stepUp: 'recent' }), admin.undoFinanceReset);
  a.get('/finance/expenses', requirePermission('finance', 'view'), validate({ query: s.listExpensesQuery }), admin.listExpenses);
  a.post('/finance/expenses', requirePermission('finance', 'edit'), validate({ body: s.createExpenseBody }), admin.createExpense);
  a.patch('/finance/expenses/:id', requirePermission('finance', 'edit'), validate({ params: idParams, body: s.updateExpenseBody }), admin.updateExpense);
  a.post('/finance/expenses/:id/delete', requirePermission('finance', 'edit', { dangerous: 'deleteExpense' }), validate({ params: idParams, body: s.deleteExpenseBody }), admin.deleteExpense);

  a.get('/storefront/carts', requirePermission('storefront', 'view'), validate({ query: listCartsQuery }), storefront.listCarts);
  a.post('/storefront/carts/:id/contacted', requirePermission('storefront', 'edit'), id, storefront.markCartContacted);
  a.post('/storefront/carts/:id/dismiss', requirePermission('storefront', 'edit'), id, storefront.dismissCart);
  a.get('/storefront/summary', requirePermission('storefront', 'view'), storefront.behaviourSummary);
  a.get('/storefront/pages', requirePermission('storefront', 'view'), validate({ query: pageStatsQuery }), storefront.getPageStats);
  a.get('/missed-orders', requirePermission('missedOrders', 'view'), validate({ query: listMissedQuery }), storefront.listMissed);
  a.get('/missed-orders/export', requirePermission('missedOrders', 'view', { fields: ['export', 'customerPhone'] }), validate({ query: listMissedQuery }), storefront.exportMissed);
  a.post('/missed-orders/import', requirePermission('missedOrders', 'edit'), validate({ body: importMissedBody }), storefront.importMissed);
  a.post('/missed-orders/bulk', requirePermission('missedOrders', 'edit'), validate({ body: bulkMissedBody }), storefront.bulkMissed);
  a.patch('/missed-orders/:id', requirePermission('missedOrders', 'edit'), validate({ params: idParams, body: updateMissedBody }), storefront.updateMissed);
  a.get('/coupons', requirePermission('coupons', 'view'), couponCtl.listCoupons);
  a.post('/coupons', requirePermission('coupons', 'edit'), validate({ body: addCouponsBody }), couponCtl.addCoupons);
  a.get('/coupons/attempts', requirePermission('coupons', 'view'), couponCtl.listAttempts);
  a.post('/coupons/import', requirePermission('coupons', 'edit'), validate({ body: importCouponsBody }), couponCtl.importCoupons);
  a.patch('/coupons/:id/dates', requirePermission('coupons', 'edit'), validate({ params: idParams, body: couponDatesBody }), couponCtl.editDates);
  a.post('/coupons/:id/undo', requirePermission('coupons', 'edit'), id, couponCtl.undoChange);
  a.patch('/coupons/:id/settings', requirePermission('coupons', 'edit'), validate({ params: idParams, body: couponSettingsBody }), couponCtl.updateSettings);
  a.post('/coupons/:id/assign', requirePermission('coupons', 'edit', { fields: ['customerPhone'] }), validate({ params: idParams, body: assignCouponBody }), couponCtl.assignCoupon);
  a.post('/coupons/:id/release', requirePermission('coupons', 'edit'), id, couponCtl.releaseCoupon);
  a.post('/coupons/:id/sent', requirePermission('coupons', 'edit', { fields: ['customerPhone'] }), id, couponCtl.couponSent);
  a.post('/orders/:id/coupon', requirePermission('coupons', 'edit', { fields: ['customerPhone'], also: { orders: 'view' } }), id, couponCtl.orderCoupon);
  a.post('/orders/:id/confirmation-sent', requirePermission('orders', 'edit', { fields: ['customerPhone'] }), id, couponCtl.orderConfirmationSent);
  a.get('/founders', requirePermission('founders', 'view'), storefront.listFounders);
  a.patch('/founders/:id', requirePermission('founders', 'edit'), validate({ params: idParams, body: updateFounderBody }), storefront.updateFounder);
  a.get('/size-guide', requirePermission('siteSettings', 'view'), storefront.getSizeGuide);
  a.patch('/size-guide', requirePermission('siteSettings', 'edit'), validate({ body: sizeGuideSchema }), storefront.updateSizeGuide);
  a.get('/site-settings', requirePermission('siteSettings', 'view'), storefront.getSiteSettings);
  a.patch('/site-settings', requirePermission('siteSettings', 'edit'), validate({ body: siteSettingsSchema }), storefront.updateSiteSettings);
  // Phase 4/5: ready-made WhatsApp texts (everyone who may message customers reads them)
  // and the log of a WhatsApp button press.
  const waSections = ['orders', 'storefront', 'missedOrders', 'coupons', 'founders'];
  a.get('/wa-templates', requirePermission(waSections, 'view', { fields: ['customerPhone'] }), staffCtl.getWaTemplates);
  a.post('/wa/click', requirePermission(waSections, 'view', { fields: ['customerPhone'] }), validate({ body: st.waClickBody }), staffCtl.waClick);
  api.use('/admin', a);

  // ---------------- Administrator only: staff accounts, templates, activity ----------------
  // Separate router (scope "adminOnly"): none of these is ever grantable to a moderator.
  const adm = tagRouter(staffRouter(), 'adminOnly');
  adm.use(requireRole(...STAFF_ROLES), requirePasswordUpToDate);
  const recentId = requireRecentReauth();
  adm.get('/staff/catalog', adminOnly(), staffCtl.catalog);
  adm.get('/staff', adminOnly(), staffCtl.listStaff);
  adm.post('/staff', adminOnly(), recentId, validate({ body: st.createStaffBody }), staffCtl.createStaff);
  adm.get('/staff/:id', adminOnly(), id, staffCtl.getStaff);
  adm.patch('/staff/:id', adminOnly(), recentId, validate({ params: idParams, body: st.updateStaffBody }), staffCtl.updateStaff);
  adm.post('/staff/:id/status', adminOnly(), validate({ params: idParams, body: st.staffStatusBody }), staffCtl.setStaffStatus);
  adm.post('/staff/:id/password', adminOnly(), recentId, validate({ params: idParams, body: st.staffPasswordBody }), staffCtl.resetStaffPassword);
  adm.post('/staff/:id/invite', adminOnly(), recentId, id, staffCtl.regenerateStaffInvite);
  adm.post('/staff/:id/sessions/revoke', adminOnly(), id, staffCtl.revokeStaffSessions);
  adm.post('/staff/:id/sessions/:sessionId/revoke', adminOnly(), validate({ params: st.staffSessionParams }), staffCtl.revokeStaffSession);
  adm.post('/staff/:id/fields/:key/grant', adminOnly(), validate({ params: st.staffFieldParams, body: st.grantFieldBody }), staffCtl.grantStaffField);
  adm.post('/staff/:id/fields/:key/revoke', adminOnly(), validate({ params: st.staffFieldParams }), staffCtl.revokeStaffField);
  adm.get('/templates', adminOnly(), staffCtl.listTemplates);
  adm.post('/templates', adminOnly(), validate({ body: st.templateBody }), staffCtl.createTemplate);
  adm.patch('/templates/:id', adminOnly(), validate({ params: idParams, body: st.templateBody }), staffCtl.updateTemplate);
  adm.post('/templates/:id/delete', adminOnly(), id, staffCtl.deleteTemplate);
  adm.get('/templates/:id/apply-preview', adminOnly(), id, staffCtl.previewTemplate);
  adm.post('/templates/:id/apply', adminOnly(), recentId, validate({ params: idParams, body: st.applyTemplateBody }), staffCtl.applyTemplate);
  adm.get('/activity', adminOnly(), validate({ query: st.activityQuery }), staffCtl.listActivity);
  adm.get('/activity/actors', adminOnly(), staffCtl.activityActors);
  adm.patch('/wa-templates', adminOnly(), validate({ body: st.waTemplatesBody }), staffCtl.updateWaTemplates);
  api.use('/admin', adm);

  // ---------------- Courier ----------------
  const c = tagRouter(Router(), 'courier');
  c.use(requireRole('courier'), requirePasswordUpToDate);
  c.get('/orders', validate({ query: s.courierOrdersQuery }), courier.listOrders);
  c.get('/orders/:id', validate({ params: idParams }), courier.getOrder);
  c.patch('/orders/:id/status', courierActivityLog, validate({ params: idParams, body: s.courierStatusBody }), courier.updateStatus);
  c.post('/orders/:id/delivery-report', courierActivityLog, validate({ params: idParams, body: s.deliveryReportBody }), courier.deliveryReport);
  c.post('/scan', courierActivityLog, validate({ body: s.scanBody }), courier.scanParcel);
  c.get('/cash', courier.cashSummary);
  c.post('/cash/remittances', courierActivityLog, validate({ body: s.courierDeclareRemittanceBody }), courier.declareRemittance);
  c.get('/cash/remittances/:id', validate({ params: idParams }), courier.getRemittance);
  api.use('/courier', c);

  return api;
}
