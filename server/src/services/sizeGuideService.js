import { SiteSettings } from '../models/index.js';
import { DEFAULT_SIZE_GUIDE, sizeGuideSchema } from '../validators/sizeGuide.js';

// Same collection as the site settings, its own document: no new index needed.
const KEY = 'sizeGuide';

const read = (doc) => {
  const parsed = sizeGuideSchema.safeParse(doc?.settings);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SIZE_GUIDE);
};

export async function getSizeGuide() {
  const doc = await SiteSettings.findOne({ key: KEY }).lean();
  return { guide: read(doc), revision: doc?.revision || 0, updatedAt: doc?.updatedAt || null };
}

export async function updateSizeGuide(user, guide) {
  await SiteSettings.updateOne(
    { key: KEY },
    { $set: { settings: guide, updatedBy: user._id }, $inc: { revision: 1 } },
    { upsert: true },
  );
  return getSizeGuide();
}
