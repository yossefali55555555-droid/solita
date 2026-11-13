import { ingestEvents } from '../services/storefrontService.js';
import { getPublicSiteConfig } from '../services/siteSettingsService.js';

// POST /api/public/events
export async function postEvents(req, res) {
  const result = await ingestEvents(req.valid.body);
  res.status(202).json({ ok: true, ...result });
}

// GET /api/public/site-config
export async function getSiteConfig(_req, res) {
  const config = await getPublicSiteConfig();
  res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
  res.json(config);
}
