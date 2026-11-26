import { z } from 'zod';

/**
 * Size guide (/pages/size-guide and the size block on product pages).
 * Edited in the dashboard, read by storefront/solita-sizes.vercel.js through
 * GET /api/public/size-guide. `mm[size]` is the inner insole length; a model
 * without a value for a size is not offered in that size.
 * The defaults equal what the live site showed before this page existed.
 */

const text = (max) => z.string().trim().max(max);

export const sizeGuideSchema = z
  .strictObject({
    margin: z.number().min(0).max(40),
    sizes: z
      .array(z.strictObject({ size: z.number().int().min(15).max(55), visible: z.boolean() }))
      .min(1, 'أضف مقاسًا واحدًا على الأقل')
      .max(20),
    models: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9-]{1,30}$/, 'معرّف الموديل: حروف إنجليزية صغيرة وأرقام و -'),
          name: text(60).min(1, 'اكتب اسم الموديل'),
          sub: text(60),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          // Store products whose SKU starts with this belong to the model.
          skuPrefix: z.string().trim().regex(/^[A-Za-z0-9._-]{1,60}$/, 'اكتب بداية رمز المنتج (SKU)'),
          visible: z.boolean(),
          mm: z.record(z.string().regex(/^\d{2}$/), z.number().int().min(150).max(400)),
        }),
      )
      .max(40),
    texts: z.strictObject({
      heroTitle: text(80),
      heroAccent: text(80),
      heroText: text(200),
      inputLabel: text(150),
      inputHint: text(150),
      button: text(30),
      howTitle: text(60),
      steps: z.array(text(250).min(1)).max(8),
      tip: text(300),
      colFoot: text(80),
      colInsole: text(80),
      colSize: text(40),
      whyTitle: text(80),
      whyText: text(600),
      caption1: text(60),
      caption2: text(60),
      caption3: text(60),
      ctaText: text(200),
      ctaButton: text(40),
    }),
  })
  .superRefine((v, ctx) => {
    const unique = (list) => new Set(list).size === list.length;
    if (!unique(v.sizes.map((s) => s.size))) ctx.addIssue({ code: 'custom', path: ['sizes'], message: 'يوجد مقاس مكرر' });
    if (!unique(v.models.map((m) => m.id))) ctx.addIssue({ code: 'custom', path: ['models'], message: 'يوجد موديل مكرر' });
  });

const SIZES = [41, 42, 43, 44, 45];
const model = (id, name, sub, color, skuPrefix, mm) => ({
  id,
  name,
  sub,
  color,
  skuPrefix,
  visible: true,
  mm: Object.fromEntries(SIZES.map((s, i) => [String(s), mm[i]])),
});
const STD = [260, 265, 270, 275, 280];

export const DEFAULT_SIZE_GUIDE = Object.freeze({
  margin: 10,
  sizes: SIZES.map((size) => ({ size, visible: true })),
  models: [
    model('alex', 'الكسندر ماكوين', '', '#A65F45', 'alex', STD),
    model('samba', 'سامبا', '', '#4A5140', 'samba', STD),
    model('nike', 'نايك إير SB', '', '#8a9279', 'nikeairSB', [260, 265, 270, 280, 285]),
    model('salxw', 'سالاكسي', 'اللون الأبيض', '#B7AA96', 'SALX-W', [265, 270, 275, 280, 285]),
    model('salxb', 'سالاكسي', 'اللون الأسود', '#6b5a48', 'SALX-B', [255, 265, 270, 280, 290]),
    model('ajek', 'أجيك', '', '#A65F45', 'AJEK', STD),
    model('morebai', 'مورباي', '', '#4A5140', 'morebai', STD),
  ],
  texts: {
    heroTitle: 'مقاسك الصحيح،',
    heroAccent: 'من أول مرة',
    heroText: 'لكل موديل قالبه الخاص. اختر الموديل، وقِس قدمك، ونقترح عليك المقاس المناسب.',
    inputLabel: 'طول قدمك كما قسته، من الكعب حتى أطول إصبع (بالسنتيمتر)',
    inputHint: 'لا تُضِف السنتيمتر بنفسك، فالحاسبة تضيفه تلقائيًا.',
    button: 'احسب مقاسي',
    howTitle: 'طريقة القياس بالتفصيل',
    steps: [
      'ضع ورقة على الأرض ملاصقة للحائط، وقف عليها وكعبك ملامس للحائط.',
      'ضع علامة عند طرف أطول إصبع، ثم قِس المسافة من الحائط حتى العلامة.',
      'كرّر القياس للقدم الأخرى، واعتمد القياس الأطول.',
    ],
    tip: 'يُفضّل أن تقيس قدمك وأنت واقف، وفي المساء، حين تكون القدم في أكبر حجم لها خلال اليوم.',
    colFoot: 'طول القدم (من الكعب حتى أطول إصبع)',
    colInsole: 'طول الفرش المناسب',
    colSize: 'المقاس المقترح',
    whyTitle: 'لماذا نضيف سنتيمترًا؟',
    whyText:
      'عندما تقف وتمشي ينبسط قوس قدمك تحت وزن جسمك فتطول بضعة مليمترات، كما يزداد حجمها قليلًا في نهاية اليوم. لذلك نترك مسافة سنتيمتر تقريبًا بين أطول إصبع ونهاية الفرش لتتحرك أصابعك براحة.',
    caption1: 'ضع كعبك ملامسًا للحائط',
    caption2: 'قِس حتى طرف أطول إصبع',
    caption3: 'ونحن نضيف سنتيمترًا للراحة',
    ctaText: 'لكل موديل قالبه. قِس قدمك في دقيقة، واعرف رقمك الصحيح في هذا الموديل.',
    ctaButton: 'اعرف مقاسك الصحيح',
  },
});
