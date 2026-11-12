import { z } from 'zod';

/**
 * Storefront settings: one schema used for admin writes, for merging stored
 * data with defaults, and for the public /api/public/site-config output.
 *
 * Texts shown on the website are Modern Standard Arabic with an English
 * version for the site's English mode. The defaults equal what the live site
 * shows today, so publishing these settings changes nothing until the owner
 * edits them. The prefilled WhatsApp messages are kept exactly as the live
 * site writes them.
 *
 * `admin` holds dashboard-only settings and is never sent to the storefront.
 */

const text = (max) => z.string().trim().max(max);
const localized = (max) => z.strictObject({ ar: text(max), en: text(max) });

// EasyOrders SKUs as used by the storefront (letters, digits, . _ -).
const sku = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z0-9._-]*$/, 'رمز المنتج (SKU) يحتوي على أحرف غير مسموحة');

// Relative site path or an https URL. Never javascript:, data:, etc.
const link = z
  .string()
  .trim()
  .max(500)
  .regex(/^(\/[^\s]*|https:\/\/[^\s]+)?$/, 'الرابط يجب أن يبدأ بـ / أو https://');

export const SHELF_LINES = 6;
export const CARD_SPEEDS = ['slow', 'normal', 'fast'];
export const SUGGESTION_ORDERS = ['random', 'easyorders'];

const feature = z.strictObject({ title: localized(60), text: localized(200) });

export const siteSettingsSchema = z.strictObject({
  toggles: z.strictObject({
    shelf: z.boolean(),
    cards: z.boolean(),
    sounds: z.boolean(),
    trackingBubble: z.boolean(),
  }),
  shelf: z.strictObject({
    lines: z
      .array(
        z.strictObject({
          sku,
          fallbacks: z.array(sku.min(1)).max(10, 'عشرة بدائل كحد أقصى لكل رف'),
        }),
      )
      .length(SHELF_LINES, `يجب أن تكون الرفوف ${SHELF_LINES} بالضبط`),
  }),
  cards: z.strictObject({ speed: z.enum(CARD_SPEEDS) }),
  suggestions: z.strictObject({
    count: z.number().int().min(0).max(24),
    order: z.enum(SUGGESTION_ORDERS),
  }),
  cartReminder: z.strictObject({
    enabled: z.boolean(),
    messages: z.array(localized(300)).max(10, 'عشر رسائل كحد أقصى'),
  }),
  announcement: z.strictObject({
    enabled: z.boolean(),
    text: localized(200),
    link,
  }),
  features: z.strictObject({
    shipping: feature,
    customerCare: feature,
    warranty: feature,
    payment: feature,
  }),
  gift: z.strictObject({ title: localized(80), text: localized(200) }),
  whatsapp: z.strictObject({
    account: text(60),
    productMessage: localized(500),
    generalMessage: localized(500),
  }),
  delivery: z.strictObject({ text: localized(200) }),
  admin: z.strictObject({
    cartWhatsappTemplate: text(1000),
  }),
});

export const DEFAULT_SITE_SETTINGS = Object.freeze({
  toggles: { shelf: true, cards: true, sounds: true, trackingBubble: true },
  shelf: {
    lines: [
      { sku: 'alex333-BBGoldtext', fallbacks: [] },
      { sku: 'nikeairSB-GreyBabyBlue', fallbacks: [] },
      { sku: 'samba-WB', fallbacks: [] },
      { sku: 'morebaiA-BW', fallbacks: [] },
      { sku: 'SALX-W', fallbacks: [] },
      { sku: 'AJEK-WW-AM', fallbacks: [] },
    ],
  },
  cards: { speed: 'normal' },
  suggestions: { count: 8, order: 'random' },
  cartReminder: {
    enabled: true,
    messages: [
      {
        ar: 'ما زال حذاؤك في السلة بانتظارك. أكمل طلبك في خطوة واحدة.',
        en: 'Your pair is still waiting in your cart. Finish your order in one step.',
      },
      {
        ar: 'المقاسات تنفد بسرعة، ومقاسك ما زال متوفرًا الآن.',
        en: 'Sizes sell out fast, and yours is still available right now.',
      },
      {
        ar: 'هل لديك سؤال قبل إتمام الطلب؟ راسلنا عبر واتساب وسنرد عليك سريعًا.',
        en: 'Got a question before you order? Message us on WhatsApp and we will reply quickly.',
      },
    ],
  },
  announcement: { enabled: false, text: { ar: '', en: '' }, link: '' },
  features: {
    shipping: {
      title: { ar: 'شحن مجاني', en: 'Free shipping' },
      text: { ar: 'على الطلبات التي تتجاوز 1499 ج.م', en: 'On orders over 1499 EGP' },
    },
    customerCare: {
      title: { ar: 'خدمة العملاء', en: 'Customer care' },
      text: { ar: 'متاحون طوال الأسبوع للإجابة عن أسئلتكم', en: 'Here all week to answer your questions' },
    },
    warranty: {
      title: { ar: 'ضمان 45 يومًا', en: '45-day warranty' },
      text: { ar: 'إذا ظهرت أي مشكلة في التصنيع أو الخامات', en: 'If any manufacturing or material issue shows up' },
    },
    payment: {
      title: { ar: 'دفع آمن', en: 'Secure payment' },
      text: { ar: 'تتم معالجة بيانات الدفع بشكل آمن', en: 'Your payment details are handled safely' },
    },
  },
  gift: {
    title: { ar: 'هدية مع كل حذاء', en: 'A gift with every pair' },
    text: { ar: 'شرابات بلون يناسب الحذاء.', en: 'A pair of matching socks.' },
  },
  whatsapp: {
    account: '@solita.917',
    productMessage: {
      ar: 'أهلًا سوليتا، كنت بتفرج على كوتش «{product}» وعجبني، وعندي سؤال صغير عنه.',
      en: 'Hi Solita, I was looking at the {product} sneakers and loved them. I have a quick question about them.',
    },
    generalMessage: {
      ar: 'أهلًا سوليتا، كنت بتفرج على الموقع وعندي سؤال صغير.',
      en: 'Hi Solita, I was browsing your site and have a quick question.',
    },
  },
  delivery: {
    text: {
      ar: 'يستغرق التوصيل عادةً من 1 إلى 3 أيام عمل (أيام العمل من الأحد إلى الخميس).',
      en: 'Delivery usually takes 1 to 3 working days (Sunday to Thursday).',
    },
  },
  admin: {
    cartWhatsappTemplate:
      'مرحبًا {name}، معك فريق سوليتا.\nلاحظنا أنك أضفت إلى سلتك: {items}\nالإجمالي: {total}.\nهل يمكننا مساعدتك في إتمام طلبك أو الإجابة عن أي سؤال؟',
  },
});

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Stored settings → complete, valid settings. Each top-level section is
 * validated on its own; a missing or invalid section falls back to its
 * default, so one bad section never breaks the whole site configuration.
 */
export function mergeWithDefaults(stored) {
  const out = clone(DEFAULT_SITE_SETTINGS);
  if (!stored || typeof stored !== 'object') return out;
  for (const [key, schema] of Object.entries(siteSettingsSchema.shape)) {
    if (stored[key] === undefined) continue;
    const merged = deepMerge(out[key], stored[key]);
    const parsed = schema.safeParse(merged);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

function deepMerge(base, value) {
  if (Array.isArray(value) || typeof value !== 'object' || value === null) return value;
  const result = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(value)) result[k] = deepMerge(result[k], v);
  return result;
}

/** The part of the settings the storefront may read. */
export function publicSiteConfig(settings) {
  const rest = { ...settings };
  delete rest.admin;
  return rest;
}
