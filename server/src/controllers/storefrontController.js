import { paginated, paginationParams } from '../utils/pagination.js';
import * as storefront from '../services/storefrontService.js';
import * as founders from '../services/founderService.js';
import * as siteSettings from '../services/siteSettingsService.js';
import * as pageStats from '../services/pageStatService.js';
import * as missed from '../services/missedOrderService.js';

// ---------- Abandoned carts ----------
export async function listCarts(req, res) {
  const page = paginationParams(req.valid.query);
  const { items, total } = await storefront.listCarts(req.valid.query, page);
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
export async function listFounders(_req, res) {
  res.json(await founders.listFounders());
}

export async function updateFounder(req, res) {
  res.json({ founder: await founders.updateFounder(req.valid.params.id, req.valid.body) });
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
  const { items, total, counts, priorityCounts, reasons } = await missed.listMissedOrders(req.valid.query, page);
  res.json({ ...paginated(items, total, page), counts, priorityCounts, reasons });
}

export async function bulkMissed(req, res) {
  const { ids, ...body } = req.valid.body;
  res.json(await missed.bulkUpdateMissed(req.user, ids, body));
}

export async function updateMissed(req, res) {
  res.json({ item: await missed.updateMissedOrder(req.user, req.valid.params.id, req.valid.body) });
}
