import { SiteSettings } from '../models/index.js';
import { publicFounderCounter } from './founderService.js';
import { DEFAULT_SITE_SETTINGS, mergeWithDefaults, publicSiteConfig } from '../validators/siteSettings.js';
import { forbidden } from '../utils/errors.js';
import { canonicalJson } from '../utils/sanitize.js';
import { isAdmin } from './permissionService.js';

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
  // The ready-made WhatsApp texts (settings.admin.*WhatsappTemplate) are for the
  // administrator only: anyone else may save the page only if they are unchanged.
  if (!isAdmin(user)) {
    const current = mergeWithDefaults((await SiteSettings.findOne({ key: KEY }, { settings: 1 }).lean())?.settings);
    if (canonicalJson(current.admin) !== canonicalJson(settings.admin)) {
      throw forbidden('تعديل نصوص رسائل واتساب الجاهزة متاح للأدمن فقط', 'WHATSAPP_TEMPLATES_ADMIN_ONLY');
    }
  }
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
  const settings = publicSiteConfig(mergeWithDefaults(doc?.settings));
  // Founders counter: live numbers only (no customer data); the stored section holds the rules.
  settings.founders = await publicFounderCounter();
  return {
    revision: doc?.revision || 0,
    updatedAt: doc?.updatedAt || null,
    settings,
  };
}
