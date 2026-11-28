import { paginated, paginationParams } from '../utils/pagination.js';
import * as storefront from '../services/storefrontService.js';
import * as founders from '../services/founderService.js';
import * as siteSettings from '../services/siteSettingsService.js';
import * as sizeGuide from '../services/sizeGuideService.js';
import * as pageStats from '../services/pageStatService.js';
import * as missed from '../services/missedOrderService.js';
import { recordActivity } from '../services/activityService.js';
import { actorLabel, raiseAlert } from '../services/alertService.js';

// ---------- Abandoned carts ----------
export async function listCarts(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await storefront.listCarts(req.valid.query, page, { viewer: req.viewer });
  res.json(paginated(items, total, page));
}

export async function markCartContacted(req, res) {
  res.json({ cart: await storefront.markCartContacted(req.user, req.valid.params.id) });
}

export async function dismissCart(req, res) {
  res.json({ cart: await storefront.dismissCart(req.user, req.valid.params.id) });
}

export async function behaviourSummary(_req, res) {
  res.json(await storefront.behaviourSummary());
}

// ---------- Founders ----------
export async function listFounders(req, res) {
  res.json(await founders.listFounders(req.viewer));
}

export async function updateFounder(req, res) {
  res.json({ founder: await founders.updateFounder(req.valid.params.id, req.valid.body) });
}

// ---------- Size guide ----------
export async function getSizeGuide(_req, res) {
  res.json(await sizeGuide.getSizeGuide());
}

export async function updateSizeGuide(req, res) {
  res.json(await sizeGuide.updateSizeGuide(req.user, req.valid.body));
}

// ---------- Site settings ----------
export async function getSiteSettings(_req, res) {
  res.json(await siteSettings.getSiteSettings());
}

export async function updateSiteSettings(req, res) {
  res.json(await siteSettings.updateSiteSettings(req.user, req.valid.body));
}

export async function getPageStats(req, res) {
  res.json(await pageStats.getPageStats(req.valid.query));
}

export async function importMissed(req, res) {
  res.json(await missed.importMissedOrders(req.user, req.valid.body.text));
}

export async function listMissed(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total, counts, priorityCounts, reasons } = await missed.listMissedOrders(req.valid.query, page, req.viewer);
  res.json({ ...paginated(items, total, page), counts, priorityCounts, reasons });
}

export async function bulkMissed(req, res) {
  const { ids, ...body } = req.valid.body;
  res.json(await missed.bulkUpdateMissed(req.user, ids, body));
}

export async function updateMissed(req, res) {
  res.json({ item: await missed.updateMissedOrder(req.user, req.valid.params.id, req.valid.body, req.viewer) });
}

// GET /missed-orders/export: CSV built on the server (route needs export + customerPhone).
// The row count is written to the audit trail before the file is sent.
export async function exportMissed(req, res) {
  const { count, csv } = await missed.exportMissedOrders(req.valid.query, req.viewer);
  // Every export is a line in the staff activity log (phase 5; was an OrderEvent in phase 2).
  await recordActivity({
    actor: req.user,
    action: 'export.missed_orders',
    severity: 'danger',
    sentence: `تصدير ملف الطلبات الفائتة إلى إكسل (${count} صفًا)`,
    targets: [{ type: 'other', label: 'الطلبات الفائتة' }],
    after: { rows: count, filters: req.valid.query },
    sessionId: req.authSession?._id || null,
  });
  if (req.user.role !== 'admin') {
    await raiseAlert({
      type: 'staff_export',
      key: `staff_export:${req.user._id}:${Date.now()}`, // every export is its own line
      actor: req.user,
      message: `${actorLabel(req.user)} صدّر ملف الطلبات الفائتة (${count} صفًا) ومعه أرقام العملاء.`,
    });
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="missed-orders.csv"',
    'Cache-Control': 'no-store',
  });
  res.send(csv);
}
