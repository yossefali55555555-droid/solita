import mongoose from 'mongoose';
import { DELIVERY_STATUS_AR } from '../constants/activity.js';
import { CashRemittance, CouponAssignment, DeliveryReview, Expense, Founder, MissedOrder, Order, StorefrontCart, User } from '../models/index.js';
import { SiteSettings } from '../models/index.js';
import { mergeWithDefaults } from '../validators/siteSettings.js';
import { parseParcelCode } from './labelService.js';
import { raiseAlert } from './alertService.js';
import { cairoDate, recordActivity } from './activityService.js';
import { logger } from '../utils/logger.js';

/**
 * One descriptor per state-changing staff route: it turns the request (and,
 * for edits, the state loaded BEFORE the handler ran) into one readable
 * Arabic line (SPEC (ز)). The permission middleware calls `attachActivityLog`
 * after a request passes the checks; the line is written, awaited, before
 * the reply leaves (a serverless function may freeze right after replying).
 *
 * Wording: a neutral verbal noun, never a gendered verb, and never a phone
 * number (recordActivity also scrubs anything number-like).
 *
 * A route without a descriptor still gets a generic line, and the
 * route-permission test fails, so a new route cannot go unlogged.
 */

const q = (x) => `«${x}»`;
const egp = (minor) => `${(Number(minor || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
const day = (d) => (d ? cairoDate(d) : 'بلا تاريخ');
const st = (v) => DELIVERY_STATUS_AR[v] || v || '—';
const num = (o) => (o ? String(o.easyOrdersShortId ?? o.easyOrdersId ?? '؟') : '؟');
const oid = (v) => (v && mongoose.isValidObjectId(v) ? String(v) : null);
const cut = (s, n = 120) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
const valid = (req) => req.valid?.body ?? req.body ?? {};
const withReason = (text, reason) => (reason ? `${text} (السبب: ${cut(reason)})` : text);

const EXPENSE_AR = { purchases: 'بضاعة', shipping: 'شحن', ads: 'إعلانات', salaries: 'رواتب', rent: 'إيجار', packaging: 'تغليف', utilities: 'مرافق', other: 'أخرى' };
const BULK_AR = { mark_test: 'تعليم كتجريبي', unmark_test: 'إلغاء التعليم كتجريبي', hide: 'إخفاء من اللوحة', unassign: 'إلغاء الإسناد', assign: 'إسناد إلى مندوب', cancel: 'إلغاء', reopen: 'إعادة فتح' };

async function pre(model, id, select, populate) {
  const v = oid(id);
  if (!v) return null;
  let query = model.findById(v).select(select);
  if (populate) query = query.populate(populate.path, populate.select);
  return query.lean();
}
const loadOrder = (req) => pre(Order, req.params.id, 'easyOrdersShortId easyOrdersId customer.name deliveryStatus isTest', null);
const orderT = (o, req) => ({ type: 'order', id: o?._id || req.params.id, label: `طلب ${num(o)}` });

const D = {};
const on = (key, d) => {
  D[key] = d;
};

// ---------------------------------------------------------------- couriers
on('POST /couriers', { action: 'courier.created', describe: ({ body }) => ({ sentence: `إنشاء حساب المندوب ${q(body.name)}`, targets: [{ type: 'courier', label: body.name }] }) });
on('PATCH /couriers/:id', {
  action: 'courier.updated',
  load: (req) => pre(User, req.params.id, 'name email'),
  describe: ({ body, pre: p, req }) => {
    const fields = [body.name !== undefined && 'الاسم', body.phone !== undefined && 'رقم الهاتف', body.email !== undefined && 'البريد'].filter(Boolean);
    const nameChange = body.name !== undefined && p?.name !== body.name;
    return {
      sentence: `تعديل بيانات المندوب ${q(p?.name || '؟')} (${fields.join('، ')})${nameChange ? ` — الاسم من ${q(p?.name)} إلى ${q(body.name)}` : ''}`,
      targets: [{ type: 'courier', id: req.params.id, label: p?.name }],
      before: nameChange ? { name: p?.name } : undefined,
      after: nameChange ? { name: body.name } : undefined,
    };
  },
});
on('PATCH /couriers/:id/active', {
  action: 'courier.active_changed',
  load: (req) => pre(User, req.params.id, 'name isActive'),
  describe: ({ body, pre: p, req }) => ({
    sentence: `${body.isActive ? 'تفعيل' : 'إيقاف'} حساب المندوب ${q(p?.name || '؟')}`,
    targets: [{ type: 'courier', id: req.params.id, label: p?.name }],
    before: { isActive: p?.isActive },
    after: { isActive: body.isActive },
  }),
});
on('POST /couriers/:id/password', {
  action: 'auth.courier_password_reset',
  severity: 'security',
  load: (req) => pre(User, req.params.id, 'name'),
  describe: ({ pre: p, req }) => ({ sentence: `إعادة تعيين كلمة سر المندوب ${q(p?.name || '؟')}`, targets: [{ type: 'courier', id: req.params.id, label: p?.name }] }),
});

// ---------------------------------------------------------------- orders
on('POST /orders/bulk', {
  action: 'order.bulk',
  describe: ({ body, result }) => {
    const done = result?.updated ?? result?.count ?? result?.modified ?? body.ids?.length ?? 0;
    return { sentence: `${BULK_AR[body.action] || body.action} لـ ${done} طلب${body.reason ? ` (السبب: ${cut(body.reason)})` : ''}`, after: { action: body.action, count: done } };
  },
});
on('POST /orders/:id/notes', {
  action: 'order.note_added',
  load: loadOrder,
  describe: ({ body, pre: p, req }) => ({ sentence: `إضافة ملاحظة ${body.type === 'public' ? 'ظاهرة للعميل' : 'داخلية'} على الطلب ${num(p)}: ${q(cut(body.text, 80))}`, targets: [orderT(p, req)] }),
});
on('POST /orders/:id/notes/:noteId/retry', { action: 'order.note_retried', load: loadOrder, describe: ({ pre: p, req }) => ({ sentence: `إعادة محاولة إرسال ملاحظة الطلب ${num(p)} إلى EasyOrders`, targets: [orderT(p, req)] }) });
on('POST /orders/:id/test', {
  action: 'order.test_flag',
  severity: 'danger',
  load: loadOrder,
  describe: ({ body, pre: p, req }) => ({ sentence: `${body.isTest ? 'تعليم' : 'إلغاء تعليم'} الطلب ${num(p)} كطلب تجريبي`, targets: [orderT(p, req)], before: { isTest: Boolean(p?.isTest) }, after: { isTest: body.isTest } }),
});
on('POST /orders/clear', { action: 'order.cleared', severity: 'danger', describe: ({ result }) => ({ sentence: `إخفاء الطلبات الظاهرة من اللوحة (${result?.cleared ?? 0} طلب)`, after: { count: result?.cleared ?? 0 } }) });
on('POST /orders/restore-cleared', { action: 'order.restored', severity: 'danger', describe: ({ result }) => ({ sentence: `استرجاع الطلبات المخفية إلى اللوحة (${result?.restored ?? 0} طلب)`, after: { count: result?.restored ?? 0 } }) });
on('PATCH /orders/:id/assignment', {
  action: 'order.assigned',
  load: async (req) => ({ order: await pre(Order, req.params.id, 'easyOrdersShortId easyOrdersId assignedTo', { path: 'assignedTo', select: 'name' }) }),
  describe: async ({ body, pre: p, req }) => {
    const o = p?.order;
    const target = body.courierId ? await pre(User, body.courierId, 'name') : null;
    const was = o?.assignedTo?.name;
    let sentence;
    if (!body.courierId) sentence = `إلغاء إسناد الطلب ${num(o)}${was ? ` من المندوب ${q(was)}` : ''}`;
    else if (was) sentence = `إعادة إسناد الطلب ${num(o)} من المندوب ${q(was)} إلى ${q(target?.name || '؟')}`;
    else sentence = `إسناد الطلب ${num(o)} إلى المندوب ${q(target?.name || '؟')}`;
    return { sentence, targets: [orderT(o, req)], before: { courier: was || null }, after: { courier: target?.name || null } };
  },
});
on('PATCH /orders/:id/status', {
  action: 'order.status_changed',
  // Frequent and already in the order timeline: kept 90 days, not a year (shows in the log, no alert).
  severity: 'normal',
  load: loadOrder,
  describe: ({ body, pre: p, req }) => ({
    sentence: withReason(`تغيير حالة الطلب ${num(p)} من ${q(st(p?.deliveryStatus))} إلى ${q(st(body.status))}`, body.reason),
    targets: [orderT(p, req)],
    before: { status: p?.deliveryStatus },
    after: { status: body.status },
  }),
});
on('POST /orders/:id/conflict/acknowledge', { action: 'order.conflict_acknowledged', load: loadOrder, describe: ({ pre: p, req }) => ({ sentence: `اعتماد تغيير البيانات الواصل من EasyOrders للطلب ${num(p)}`, targets: [orderT(p, req)] }) });

// ---------------------------------------------------------------- delivery reviews, returns, labels
const loadReviewOrder = async (req) => {
  const review = await pre(DeliveryReview, req.params.id, 'order');
  return { order: review?.order ? await pre(Order, review.order, 'easyOrdersShortId easyOrdersId deliveryStatus') : null };
};
on('POST /delivery-reviews/:id/approve', { action: 'delivery.review_approved', load: loadReviewOrder, describe: ({ pre: p }) => ({ sentence: `اعتماد تقرير تسليم الطلب ${num(p?.order)}`, targets: p?.order ? [orderT(p.order, {})] : [] }) });
on('POST /delivery-reviews/:id/reject', { action: 'delivery.review_rejected', load: loadReviewOrder, describe: ({ body, pre: p }) => ({ sentence: withReason(`رفض تقرير تسليم الطلب ${num(p?.order)}`, body.reason), targets: p?.order ? [orderT(p.order, {})] : [] }) });
on('POST /orders/:id/return', {
  action: 'delivery.return_confirmed',
  load: loadOrder,
  describe: ({ pre: p, req, body }) => ({ sentence: withReason(`تأكيد مرتجع الطلب ${num(p)}`, body.reason), targets: [orderT(p, req)], before: { status: p?.deliveryStatus }, after: { status: 'returned' } }),
});
on('POST /labels/print', { action: 'delivery.labels_printed', describe: ({ body }) => ({ sentence: `طباعة بوليصة لعدد ${body.orderIds?.length ?? 0} طلب` }) });
on('POST /returns/scan', {
  action: 'delivery.parcel_scanned',
  describe: async ({ body }) => {
    const parsed = parseParcelCode(body.code);
    return { sentence: parsed ? `مسح طرد راجع بالمخزن للطلب ${parsed.number} (طرد ${parsed.n} من ${parsed.total})` : 'مسح طرد راجع بالمخزن' };
  },
});

// ---------------------------------------------------------------- sync
on('POST /sync/process-due', { action: 'sync.process_due', describe: () => ({ sentence: 'تشغيل المزامنة المعلّقة يدويًا' }) });
on('POST /easyorders/poll', { action: 'sync.poll', describe: () => ({ sentence: 'سحب الطلبات الجديدة من EasyOrders يدويًا' }) });
on('POST /easyorders/import', { action: 'sync.import', describe: ({ body }) => ({ sentence: `استيراد الطلب ${body.shortId ?? '(بمعرّف EasyOrders)'} من EasyOrders` }) });
on('POST /sync/webhooks/:id/retry', { action: 'sync.retry', describe: () => ({ sentence: 'إعادة معالجة حدث ويب هوك فاشل' }) });
on('POST /sync/:id/retry', { action: 'sync.retry', describe: () => ({ sentence: 'إعادة محاولة مزامنة فاشلة مع EasyOrders' }) });

// ---------------------------------------------------------------- cash
on('POST /cash/reset', { action: 'cash.reset', severity: 'danger', describe: () => ({ sentence: 'تصفير الخزنة' }) });
on('POST /cash/reset/undo', { action: 'cash.reset_undone', severity: 'danger', describe: () => ({ sentence: 'التراجع عن تصفير الخزنة' }) });
const loadRemittance = async (req) => {
  const r = await pre(CashRemittance, req.params.id, 'courier', null);
  return { courier: r?.courier ? await pre(User, r.courier, 'name') : null };
};
on('POST /cash/remittances', {
  action: 'cash.remittance_created',
  describe: async ({ body }) => {
    const courier = await pre(User, body.courierId, 'name');
    return { sentence: `إنشاء تسوية نقدية مع المندوب ${q(courier?.name || '؟')} عن ${body.orderIds?.length ?? 0} طلب بمبلغ ${egp(body.handedOverAmount)}`, targets: [{ type: 'courier', id: body.courierId, label: courier?.name }], after: { amount: body.handedOverAmount } };
  },
});
on('POST /cash/remittances/:id/receive', { action: 'cash.remittance_received', load: loadRemittance, describe: ({ body, pre: p, req }) => ({ sentence: `استلام تسوية المندوب ${q(p?.courier?.name || '؟')} بمبلغ ${egp(body.handedOverAmount)}`, targets: [{ type: 'remittance', id: req.params.id, label: `تسوية ${p?.courier?.name || ''}` }], after: { amount: body.handedOverAmount } }) });
on('POST /cash/remittances/:id/verify', { action: 'cash.remittance_verified', load: loadRemittance, describe: ({ body, pre: p, req }) => ({ sentence: `تحقق من تسوية المندوب ${q(p?.courier?.name || '؟')} بمبلغ ${egp(body.verifiedAmount)}`, targets: [{ type: 'remittance', id: req.params.id, label: `تسوية ${p?.courier?.name || ''}` }], after: { amount: body.verifiedAmount } }) });
on('POST /cash/remittances/:id/cancel', { action: 'cash.remittance_cancelled', load: loadRemittance, describe: ({ body, pre: p, req }) => ({ sentence: withReason(`إلغاء تسوية المندوب ${q(p?.courier?.name || '؟')}`, body.reason), targets: [{ type: 'remittance', id: req.params.id, label: `تسوية ${p?.courier?.name || ''}` }] }) });

// ---------------------------------------------------------------- finance
on('POST /finance/reset', { action: 'finance.reset', severity: 'danger', describe: () => ({ sentence: 'تصفير الماليات' }) });
on('POST /finance/reset/undo', { action: 'finance.reset_undone', severity: 'danger', describe: () => ({ sentence: 'التراجع عن تصفير الماليات' }) });
on('POST /finance/expenses', {
  action: 'finance.expense_created',
  describe: ({ body }) => ({ sentence: `إضافة مصروف ${q(EXPENSE_AR[body.category] || body.category)}${body.description ? ` (${cut(body.description, 60)})` : ''} بمبلغ ${egp(body.amount)}`, targets: [{ type: 'expense', label: EXPENSE_AR[body.category] }], after: { category: body.category, amount: body.amount } }),
});
on('PATCH /finance/expenses/:id', {
  action: 'finance.expense_updated',
  load: (req) => pre(Expense, req.params.id, 'amount category date description'),
  describe: ({ body, pre: p, req }) => {
    const parts = [];
    const before = {};
    const after = {};
    if (body.amount !== undefined && body.amount !== p?.amount) {
      parts.push(`المبلغ من ${egp(p?.amount)} إلى ${egp(body.amount)}`);
      before.amount = p?.amount;
      after.amount = body.amount;
    }
    if (body.category !== undefined && body.category !== p?.category) {
      parts.push(`التصنيف من ${q(EXPENSE_AR[p?.category] || p?.category)} إلى ${q(EXPENSE_AR[body.category] || body.category)}`);
      before.category = p?.category;
      after.category = body.category;
    }
    if (body.date !== undefined && day(body.date) !== day(p?.date)) {
      parts.push(`التاريخ من ${day(p?.date)} إلى ${day(body.date)}`);
      before.date = day(p?.date);
      after.date = day(body.date);
    }
    if (!parts.length) parts.push('بيانات أخرى (الوصف أو الفاتورة أو المورّد)');
    return { sentence: `تعديل مصروف ${q(EXPENSE_AR[p?.category] || '؟')}: ${parts.join('، ')}`, targets: [{ type: 'expense', id: req.params.id, label: EXPENSE_AR[p?.category] }], before, after };
  },
});
on('POST /finance/expenses/:id/delete', {
  action: 'finance.expense_deleted',
  severity: 'danger',
  load: (req) => pre(Expense, req.params.id, 'amount category'),
  describe: ({ body, pre: p, req }) => ({ sentence: withReason(`حذف مصروف ${q(EXPENSE_AR[p?.category] || '؟')} بمبلغ ${egp(p?.amount)}`, body.reason), targets: [{ type: 'expense', id: req.params.id, label: EXPENSE_AR[p?.category] }], before: { amount: p?.amount } }),
});

// ---------------------------------------------------------------- storefront and missed orders
on('POST /storefront/carts/:id/contacted', { action: 'storefront.cart_contacted', load: (req) => pre(StorefrontCart, req.params.id, 'name'), describe: ({ pre: p }) => ({ sentence: `تسجيل التواصل مع صاحب سلة متروكة${p?.name ? ` ${q(p.name)}` : ''}`, targets: [{ type: 'cart', label: p?.name }] }) });
on('POST /storefront/carts/:id/dismiss', { action: 'storefront.cart_dismissed', load: (req) => pre(StorefrontCart, req.params.id, 'name'), describe: ({ pre: p }) => ({ sentence: `تجاهل سلة متروكة${p?.name ? ` لـ${q(p.name)}` : ''}`, targets: [{ type: 'cart', label: p?.name }] }) });
on('POST /missed-orders/import', { action: 'storefront.missed_imported', describe: ({ result }) => ({ sentence: `استيراد طلبات فائتة من الرسائل (${result?.created ?? result?.imported ?? result?.added ?? 0} جديد)` }) });
on('POST /missed-orders/bulk', {
  action: 'storefront.missed_bulk',
  describe: ({ body }) => {
    const what = [body.contacted !== undefined && (body.contacted ? 'تعليم كمتواصَل معهم' : 'إلغاء التواصل'), body.dismissed !== undefined && (body.dismissed ? 'تجاهل' : 'إلغاء التجاهل'), body.isTest !== undefined && (body.isTest ? 'تعليم كتجريبي' : 'إلغاء التعليم كتجريبي')].filter(Boolean);
    return { sentence: `${what.join('، ')} لعدد ${body.ids?.length ?? 0} طلب فائت`, after: { count: body.ids?.length ?? 0 } };
  },
});
on('PATCH /missed-orders/:id', {
  action: 'storefront.missed_updated',
  load: (req) => pre(MissedOrder, req.params.id, 'name'),
  describe: ({ body, pre: p, req }) => {
    const what = [body.contacted !== undefined && (body.contacted ? 'تسجيل التواصل' : 'إلغاء التواصل'), body.dismissed !== undefined && (body.dismissed ? 'تجاهل' : 'إلغاء التجاهل'), body.isTest !== undefined && (body.isTest ? 'تعليم كتجريبي' : 'إلغاء التعليم كتجريبي'), body.note !== undefined && 'تعديل الملاحظة'].filter(Boolean);
    return { sentence: `${what.join('، ')} للطلب الفائت${p?.name ? ` ${q(p.name)}` : ''}`, targets: [{ type: 'missed', id: req.params.id, label: p?.name }] };
  },
});

// ---------------------------------------------------------------- coupons
const loadCoupon = (req) => pre(CouponAssignment, req.params.id, 'code sentAt expiresAt bound isActive customerName');
const couponT = (p, req) => ({ type: 'coupon', id: req.params.id, label: p?.code });
on('POST /coupons', { action: 'coupon.added', describe: ({ body }) => ({ sentence: `إضافة ${body.codes?.length ?? 0} كود خصم إلى المخزون`, after: { count: body.codes?.length ?? 0 } }) });
on('POST /coupons/import', { action: 'coupon.imported', describe: ({ body }) => ({ sentence: `استيراد ${body.coupons?.length ?? 0} كوبون من EasyOrders` }) });
on('PATCH /coupons/:id/dates', {
  action: 'coupon.dates_changed',
  load: loadCoupon,
  describe: ({ body, pre: p, req }) => {
    const parts = [];
    const before = {};
    const after = {};
    if (body.sentAt !== undefined) {
      parts.push(`تاريخ الإرسال من ${day(p?.sentAt)} إلى ${day(body.sentAt)}`);
      before.sentAt = day(p?.sentAt);
      after.sentAt = day(body.sentAt);
    }
    if (body.expiresAt !== undefined) {
      parts.push(`تاريخ الانتهاء من ${day(p?.expiresAt)} إلى ${day(body.expiresAt)}`);
      before.expiresAt = day(p?.expiresAt);
      after.expiresAt = day(body.expiresAt);
    }
    return { sentence: `تعديل الكوبون ${q(p?.code || '؟')}: ${parts.join('، ')}`, targets: [couponT(p, req)], before, after };
  },
});
on('POST /coupons/:id/undo', { action: 'coupon.undone', load: loadCoupon, describe: ({ pre: p, req }) => ({ sentence: `التراجع عن آخر تعديل في الكوبون ${q(p?.code || '؟')}`, targets: [couponT(p, req)] }) });
on('PATCH /coupons/:id/settings', {
  action: 'coupon.settings_changed',
  load: loadCoupon,
  describe: ({ body, pre: p, req }) => {
    const parts = [body.value !== undefined && `نسبة الخصم ${body.value}%`, body.usageLimit !== undefined && `حد الاستخدام ${body.usageLimit}`, body.isActive !== undefined && (body.isActive ? 'تفعيل' : 'إيقاف'), body.bound !== undefined && (body.bound ? 'ربط بعميل' : 'فك الربط بعميل')].filter(Boolean);
    return { sentence: `تعديل إعدادات الكوبون ${q(p?.code || '؟')}: ${parts.join('، ')}`, targets: [couponT(p, req)], after: { ...body } };
  },
});
on('POST /coupons/:id/assign', { action: 'coupon.assigned', load: loadCoupon, describe: ({ body, pre: p, req }) => ({ sentence: `ربط الكوبون ${q(p?.code || '؟')} بالعميل${body.name ? ` ${q(body.name)}` : ''}`, targets: [couponT(p, req)] }) });
on('POST /coupons/:id/release', { action: 'coupon.released', load: loadCoupon, describe: ({ pre: p, req }) => ({ sentence: `فك ربط الكوبون ${q(p?.code || '؟')} عن العميل${p?.customerName ? ` ${q(p.customerName)}` : ''}`, targets: [couponT(p, req)] }) });
on('POST /coupons/:id/sent', { action: 'coupon.sent_marked', load: loadCoupon, describe: ({ pre: p, req }) => ({ sentence: `تسجيل إرسال الكوبون ${q(p?.code || '؟')} إلى العميل${p?.customerName ? ` ${q(p.customerName)}` : ''}`, targets: [couponT(p, req)] }) });
on('POST /orders/:id/coupon', {
  action: 'coupon.order_coupon',
  load: loadOrder,
  describe: ({ pre: p, req, result }) => ({ sentence: `تجهيز كوبون للعميل${p?.customer?.name ? ` ${q(p.customer.name)}` : ''} (طلب ${num(p)})${result?.coupon?.code ? ` — الكود ${q(result.coupon.code)}` : ''}`, targets: [orderT(p, req)] }),
});
on('POST /orders/:id/confirmation-sent', { action: 'order.confirmation_sent_marked', load: loadOrder, describe: ({ pre: p, req }) => ({ sentence: `تسجيل إرسال رسالة تأكيد البيانات للعميل${p?.customer?.name ? ` ${q(p.customer.name)}` : ''} (طلب ${num(p)})`, targets: [orderT(p, req)] }) });

// ---------------------------------------------------------------- founders and settings
on('PATCH /founders/:id', {
  action: 'coupon.founder_updated',
  load: (req) => pre(Founder, req.params.id, 'number name'),
  describe: ({ body, pre: p, req }) => ({ sentence: `تعديل بيانات العضو رقم ${p?.number ?? '؟'} في أوائل سوليتا (${[body.personalCode !== undefined && 'كود العضوية', body.friendCode !== undefined && 'كود الصديق', body.notes !== undefined && 'الملاحظات'].filter(Boolean).join('، ')})`, targets: [{ type: 'founder', id: req.params.id, label: p?.name }] }),
});
on('PATCH /size-guide', { action: 'settings.size_guide', describe: () => ({ sentence: 'تعديل صفحة المقاسات' }) });
on('PATCH /site-settings', {
  action: 'settings.site_changed',
  load: async () => mergeWithDefaults((await SiteSettings.findOne({ key: 'site' }, { settings: 1 }).lean())?.settings),
  describe: ({ body, pre: p }) => {
    const changed = Object.keys(body || {}).filter((k) => JSON.stringify(body[k]) !== JSON.stringify(p?.[k]));
    return { sentence: `تعديل إعدادات الموقع (${changed.length ? changed.join('، ') : 'بلا تغيير في الأقسام'})`, after: { sections: changed } };
  },
});

// ---------------------------------------------------------------- couriers' own routes
const courierOrder = (req) => pre(Order, req.params.id, 'easyOrdersShortId easyOrdersId deliveryStatus');
const COURIER = {
  'PATCH /orders/:id/status': { action: 'delivery.courier_status', load: courierOrder, describe: ({ body, pre: p, req }) => ({ sentence: withReason(`تحديث حالة الطلب ${num(p)} من ${q(st(p?.deliveryStatus))} إلى ${q(st(body.status))}`, body.reason), targets: [orderT(p, req)], before: { status: p?.deliveryStatus }, after: { status: body.status } }) },
  'POST /orders/:id/delivery-report': { action: 'delivery.report_submitted', load: courierOrder, describe: ({ pre: p, req }) => ({ sentence: `تقديم تقرير تسليم الطلب ${num(p)}`, targets: [orderT(p, req)] }) },
  'POST /scan': {
    action: 'delivery.courier_scan',
    describe: ({ body }) => {
      const parsed = parseParcelCode(body.code);
      return { sentence: parsed ? `مسح طرد الطلب ${parsed.number} (طرد ${parsed.n} من ${parsed.total})` : 'مسح طرد' };
    },
  },
  'POST /cash/remittances': { action: 'cash.courier_declared', describe: ({ body }) => ({ sentence: `إعلان تسليم نقدية بمبلغ ${egp(body.declaredAmount)} عن ${body.orderIds?.length ?? 0} طلب`, after: { amount: body.declaredAmount } }) },
};

export const STAFF_ACTIVITY = Object.freeze(D);
export const COURIER_ACTIVITY = Object.freeze(COURIER);
/** Routes that write their own line inside the handler (the descriptor is not used). */
export const MANUAL_ACTIVITY = Object.freeze(new Set(['GET /missed-orders/export', 'GET /customers/export-meta', 'POST /wa/click']));

// ---------------------------------------------------------------- runtime

async function safeLoad(d, req) {
  if (!d?.load) return undefined;
  try {
    return await d.load(req);
  } catch (err) {
    logger.warn('Activity pre-load failed', { error: err.message });
    return undefined;
  }
}

/**
 * Wrap res.json: after a successful reply is ready, write the activity line
 * (awaited, never throwing) and only then send it.
 */
function afterSuccess(res, task) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) return original(body);
    Promise.resolve()
      .then(() => task(body))
      .catch((err) => logger.warn('Activity task failed', { error: err.message }))
      .finally(() => original(body));
    return res;
  };
}

async function writeLine(req, d, key, severityDefault, pre, result) {
  const ctx = { req, body: valid(req), pre, result };
  const out = d ? await d.describe(ctx) : { sentence: `تنفيذ إجراء (${key})` };
  const severity = d?.severity || severityDefault;
  try {
    await recordActivity({
      actor: req.user,
      action: d?.action || 'other.write',
      severity,
      sentence: out.sentence,
      targets: out.targets || [],
      before: out.before,
      after: out.after,
      sessionId: req.authSession?._id || null,
    });
  } catch (err) {
    logger.error('Could not write the staff activity line', { key, error: err.message });
    // A missing line on a dangerous action must be noticed: tell the administrator.
    if (severity !== 'normal') {
      await raiseAlert({ type: 'activity_log_failed', severity: 'security', actor: req.user, message: `تعذّر تسجيل إجراء خطر في سجل النشاط (${key}). راجع الإجراء يدويًا.` });
    }
  }
}

/**
 * Called by requirePermission for every state-changing staff route. Loads the
 * state the line needs BEFORE the handler runs, then writes after success.
 */
export async function attachActivityLog(req, res, plan) {
  if (!req.user || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const key = `${req.method} ${req.route?.path}`;
  if (MANUAL_ACTIVITY.has(key)) return;
  const d = D[key];
  const preState = await safeLoad(d, req);
  const severityDefault = plan?.dangerous ? 'danger' : 'normal';
  afterSuccess(res, (result) => writeLine(req, d, key, severityDefault, preState, result));
}

/** Per-route middleware for /api/courier routes (their lines are written the same way). */
export async function courierActivityLog(req, res, next) {
  try {
    const key = `${req.method} ${req.route?.path}`;
    const d = COURIER[key];
    if (d && !['GET', 'HEAD'].includes(req.method)) {
      const preState = await safeLoad(d, req);
      afterSuccess(res, (result) => writeLine(req, d, key, 'normal', preState, result));
    }
  } catch (err) {
    logger.warn('Courier activity attach failed', { error: err.message });
  }
  next();
}
