import { paginated, paginationParams } from '../utils/pagination.js';
import * as storefront from '../services/storefrontService.js';
import * as siteSettings from '../services/siteSettingsService.js';

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

// ---------- Site settings ----------
export async function getSiteSettings(_req, res) {
  res.json(await siteSettings.getSiteSettings());
}

export async function updateSiteSettings(req, res) {
  res.json(await siteSettings.updateSiteSettings(req.user, req.valid.body));
}
