import { ACTIVITY_GROUPS, SEVERITY_LABELS } from '../constants/activity.js';
import { DANGEROUS, FIELDS, LEVEL_LABELS, SECTIONS, TEMPORARY_GRANT_PRESETS } from '../constants/permissions.js';
import { CouponAssignment, Founder, MissedOrder, Order, StorefrontCart, publicUser } from '../models/index.js';
import { sessionCookieName, sessionCookieOptions } from '../middleware/auth.js';
import { createCsrfToken, setCsrfCookie } from '../middleware/csrf.js';
import { getConfig } from '../config/env.js';
import * as staff from '../services/staffService.js';
import * as templates from '../services/templateService.js';
import * as activity from '../services/activityService.js';
import { orderLabelNumber } from '../services/labelService.js';
import { getSiteSettings, updateSiteSettings } from '../services/siteSettingsService.js';
import { effectivePermissions, hasSection } from '../services/permissionService.js';
import { forbidden, notFound } from '../utils/errors.js';

// ---------------- Catalog for the editor (single source of truth: constants/permissions.js) ----------------
export function catalog(_req, res) {
  res.json({
    levels: LEVEL_LABELS,
    sections: Object.entries(SECTIONS).map(([key, v]) => ({ key, label: v.label, lockedByDefault: Boolean(v.lockedByDefault) })),
    dangerous: Object.entries(DANGEROUS).map(([key, v]) => ({ key, label: v.label, section: v.section, stepUpAlways: Boolean(v.stepUpAlways) })),
    fields: Object.entries(FIELDS).map(([key, v]) => ({ key, label: v.label, temporary: Boolean(v.temporary) })),
    temporaryPresets: Object.keys(TEMPORARY_GRANT_PRESETS),
    activityGroups: ACTIVITY_GROUPS,
    severities: SEVERITY_LABELS,
  });
}

// ---------------- Accounts ----------------
export async function listStaff(_req, res) {
  res.json({ items: await staff.listStaff() });
}
export async function getStaff(req, res) {
  res.json({ account: await staff.getStaff(req.valid.params.id) });
}
export async function createStaff(req, res) {
  res.status(201).json(await staff.createStaff(req.user, req.valid.body));
}
export async function updateStaff(req, res) {
  res.json({ account: await staff.updateStaff(req.user, req.valid.params.id, req.valid.body) });
}
export async function setStaffStatus(req, res) {
  res.json({ account: await staff.setStatus(req.user, req.valid.params.id, req.valid.body.status) });
}
export async function resetStaffPassword(req, res) {
  res.json(await staff.resetPassword(req.user, req.valid.params.id, req.valid.body));
}
export async function regenerateStaffInvite(req, res) {
  res.json(await staff.regenerateInvite(req.user, req.valid.params.id));
}
export async function revokeStaffSessions(req, res) {
  res.json(await staff.revokeSessions(req.user, req.valid.params.id));
}
export async function revokeStaffSession(req, res) {
  res.json(await staff.revokeSessions(req.user, req.valid.params.id, req.valid.params.sessionId));
}
export async function grantStaffField(req, res) {
  res.json({ account: await staff.grantField(req.user, req.valid.params.id, req.valid.params.key, req.valid.body) });
}
export async function revokeStaffField(req, res) {
  res.json({ account: await staff.revokeField(req.user, req.valid.params.id, req.valid.params.key) });
}

// ---------------- Templates ----------------
export async function listTemplates(_req, res) {
  res.json({ items: await templates.listTemplates() });
}
export async function createTemplate(req, res) {
  res.status(201).json({ template: await templates.createTemplate(req.user, req.valid.body) });
}
export async function updateTemplate(req, res) {
  res.json(await templates.updateTemplate(req.user, req.valid.params.id, req.valid.body));
}
export async function deleteTemplate(req, res) {
  res.json(await templates.deleteTemplate(req.user, req.valid.params.id));
}
export async function previewTemplate(req, res) {
  res.json(await templates.previewApply(req.valid.params.id));
}
export async function applyTemplate(req, res) {
  res.json(await templates.applyTemplate(req.user, req.valid.params.id, req.valid.body));
}

// ---------------- Activity page ----------------
export async function listActivity(req, res) {
  res.json(await activity.listActivity(req.valid.query));
}
export async function activityActors(_req, res) {
  res.json({ items: await activity.listActors(), storage: await activity.activityStorage() });
}

// ---------------- Invite acceptance (public, by token) ----------------
export async function acceptInvite(req, res) {
  const result = await staff.acceptInvite({ ...req.valid.body, userAgent: req.get('user-agent'), ip: req.ip });
  res.cookie(sessionCookieName(), result.token, sessionCookieOptions(result.expiresAt));
  const csrfToken = createCsrfToken();
  setCsrfCookie(res, csrfToken);
  res.json({
    user: { ...publicUser(result.user), templateName: result.user.templateName || null, permissions: effectivePermissions(result.user) },
    csrfToken,
    mockMode: getConfig().mockMode,
  });
}

// ---------------- WhatsApp: ready-made texts and the click log ----------------
const WA_KEYS = ['cartWhatsappTemplate', 'couponWhatsappTemplate', 'confirmWhatsappTemplate'];

/** Everyone who may send a WhatsApp message reads the texts; only the admin edits them. */
export async function getWaTemplates(_req, res) {
  const { settings } = await getSiteSettings();
  res.json({ templates: Object.fromEntries(WA_KEYS.map((k) => [k, settings.admin[k]])) });
}

export async function updateWaTemplates(req, res) {
  const { settings } = await getSiteSettings();
  const next = { ...settings, admin: { ...settings.admin, ...req.valid.body } };
  await updateSiteSettings(req.user, next);
  await activity.recordActivity({
    actor: req.user,
    action: 'settings.whatsapp_texts',
    severity: 'danger',
    sentence: 'تعديل نصوص رسائل واتساب الجاهزة',
    targets: [{ type: 'setting', label: 'نصوص واتساب' }],
    sessionId: req.authSession?._id || null,
  });
  res.json({ templates: req.valid.body });
}

const KIND_SECTION = { order: 'orders', confirm: 'orders', coupon: 'coupons', cart: 'storefront', missed: 'missedOrders', founder: 'founders' };
const q = (x) => `«${x}»`;

async function waTarget(kind, id) {
  if (kind === 'order' || kind === 'confirm') {
    const o = await Order.findById(id).select('easyOrdersShortId easyOrdersId customer.name').lean();
    if (!o) return null;
    return { name: o.customer?.name, ref: `طلب ${orderLabelNumber(o)}`, target: { type: 'order', id: o._id, label: `طلب ${orderLabelNumber(o)}` } };
  }
  if (kind === 'coupon') {
    const c = await CouponAssignment.findById(id).select('code customerName').lean();
    return c && { name: c.customerName, ref: `كوبون ${c.code}`, target: { type: 'coupon', id: c._id, label: c.code } };
  }
  if (kind === 'cart') {
    const c = await StorefrontCart.findById(id).select('name').lean();
    return c && { name: c.name, ref: 'سلة متروكة', target: { type: 'cart', id: c._id, label: c.name } };
  }
  if (kind === 'missed') {
    const m = await MissedOrder.findById(id).select('name').lean();
    return m && { name: m.name, ref: 'طلب فائت', target: { type: 'missed', id: m._id, label: m.name } };
  }
  const f = await Founder.findById(id).select('name number').lean();
  return f && { name: f.name, ref: `عضو أوائل سوليتا رقم ${f.number}`, target: { type: 'founder', id: f._id, label: f.name } };
}

/**
 * The staff member pressed a WhatsApp button. We log that and the text that was
 * prepared for them (SPEC (د)): a wa.me link cannot prove the message was sent,
 * so the line says «فتح واتساب», never «أرسل». The number is never written.
 */
export async function waClick(req, res) {
  const { kind, id, text } = req.valid.body;
  if (!hasSection(req.user, KIND_SECTION[kind], 'view')) throw forbidden();
  const target = await waTarget(kind, id);
  if (!target) throw notFound('العنصر غير موجود');
  const label = kind === 'confirm' ? 'فتح واتساب لتأكيد البيانات مع العميل' : 'فتح واتساب للعميل';
  await activity.recordActivity({
    actor: req.user,
    action: `whatsapp.${kind}_opened`,
    sentence: `${label}${target.name ? ` ${q(target.name)}` : ''} (${target.ref})${text ? ` بنص: ${q(text.replace(/\s+/g, ' ').slice(0, 300))}` : ''}`,
    targets: [target.target],
    sessionId: req.authSession?._id || null,
  });
  res.json({ ok: true });
}
