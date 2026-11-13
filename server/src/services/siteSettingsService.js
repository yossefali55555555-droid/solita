import { SiteSettings } from '../models/index.js';
import { DEFAULT_SITE_SETTINGS, mergeWithDefaults, publicSiteConfig } from '../validators/siteSettings.js';

const KEY = 'site';

/** Complete settings (stored values merged over the defaults) with metadata. */
export async function getSiteSettings() {
  const doc = await SiteSettings.findOne({ key: KEY }).populate('updatedBy', 'name').lean();
  return {
    settings: mergeWithDefaults(doc?.settings),
    defaults: DEFAULT_SITE_SETTINGS,
    revision: doc?.revision || 0,
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy ? { _id: doc.updatedBy._id, name: doc.updatedBy.name } : null,
  };
}

/** Replace the settings with an already validated (siteSettingsSchema) object. */
export async function updateSiteSettings(user, settings) {
  await SiteSettings.updateOne(
    { key: KEY },
    { $set: { settings, updatedBy: user._id }, $inc: { revision: 1 } },
    { upsert: true },
  );
  return getSiteSettings();
}

/** What the storefront reads: no dashboard-only settings, no user data. */
export async function getPublicSiteConfig() {
  const doc = await SiteSettings.findOne({ key: KEY }, { settings: 1, revision: 1, updatedAt: 1 }).lean();
  return {
    revision: doc?.revision || 0,
    updatedAt: doc?.updatedAt || null,
    settings: publicSiteConfig(mergeWithDefaults(doc?.settings)),
  };
}
