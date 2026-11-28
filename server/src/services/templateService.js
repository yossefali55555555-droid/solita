import mongoose from 'mongoose';
import { PermissionTemplate, User } from '../models/index.js';
import { DEFAULT_TEMPLATES } from '../constants/permissions.js';
import { badRequest, conflict, isDuplicateKeyError, notFound } from '../utils/errors.js';
import { recordActivity } from './activityService.js';
import { diffPermissions, normalizePermissions, permissionsFromTemplate, plainPermissions, summarizePermissions } from './permissionEditor.js';

/**
 * Permission templates (phase 4, SPEC (ب)). An account copies a template when
 * it is created. Editing a template only edits the template; the admin then
 * sees «apply to N accounts» with a before/after comparison and decides.
 */

let seeding = null;

/** The five starting templates, written the first time the list is read. */
export async function ensureDefaultTemplates() {
  seeding ||= (async () => {
    if (await PermissionTemplate.estimatedDocumentCount()) return;
    for (const t of DEFAULT_TEMPLATES) {
      try {
        await PermissionTemplate.create({ ...t, isDefault: true });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

function shape(t, accounts = 0) {
  return {
    id: String(t._id),
    name: t.name,
    description: t.description || '',
    sections: { ...(t.sections?.toObject ? t.sections.toObject() : t.sections || {}) },
    dangerous: [...(t.dangerous || [])],
    fields: [...(t.fields || [])],
    isDefault: Boolean(t.isDefault),
    revision: t.revision,
    updatedAt: t.updatedAt,
    accounts,
  };
}

async function accountCounts() {
  const rows = await User.aggregate([{ $match: { role: 'moderator', templateName: { $type: 'string' } } }, { $group: { _id: '$templateName', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

export async function listTemplates() {
  await ensureDefaultTemplates();
  const [rows, counts] = await Promise.all([PermissionTemplate.find({}).sort({ isDefault: -1, createdAt: 1 }).lean(), accountCounts()]);
  return rows.map((t) => shape(t, counts[t.name] || 0));
}

async function templateOrThrow(id) {
  if (!mongoose.isValidObjectId(id)) throw notFound('القالب غير موجود');
  const t = await PermissionTemplate.findById(id);
  if (!t) throw notFound('القالب غير موجود');
  return t;
}

function checkedTemplateBody(body) {
  const perms = normalizePermissions({ sections: body.sections, dangerous: body.dangerous, fields: body.fields });
  return { sections: perms.sections, dangerous: perms.dangerous, fields: perms.fields.map((g) => g.key) };
}

export async function createTemplate(admin, body) {
  const data = checkedTemplateBody(body);
  try {
    const t = await PermissionTemplate.create({ name: body.name, description: body.description || '', ...data, updatedBy: admin._id });
    await recordActivity({ actor: admin, action: 'account.template_created', severity: 'security', sentence: `إنشاء قالب صلاحيات «${t.name}»`, targets: [{ type: 'template', id: t._id, label: t.name }], after: summarizePermissions({ ...data, fields: data.fields.map((key) => ({ key })) }) });
    return shape(t);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('يوجد قالب بهذا الاسم', 'DUPLICATE_TEMPLATE');
    throw err;
  }
}

export async function updateTemplate(admin, id, body) {
  const t = await templateOrThrow(id);
  const data = checkedTemplateBody(body);
  const oldName = t.name;
  const before = { sections: { ...t.sections.toObject() }, dangerous: [...t.dangerous], fields: t.fields.map((key) => ({ key })) };
  const after = { sections: data.sections, dangerous: data.dangerous, fields: data.fields.map((key) => ({ key })) };
  const lines = diffPermissions(before, after);
  if (body.name !== oldName) lines.unshift(`الاسم من «${oldName}» إلى «${body.name}»`);
  t.set({ name: body.name, description: body.description ?? t.description, sections: data.sections, dangerous: data.dangerous, fields: data.fields, updatedBy: admin._id });
  t.revision += 1;
  try {
    await t.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('يوجد قالب بهذا الاسم', 'DUPLICATE_TEMPLATE');
    throw err;
  }
  // Accounts that carry this template's name keep it as their label after a rename.
  if (body.name !== oldName) await User.updateMany({ role: 'moderator', templateName: oldName }, { $set: { templateName: body.name } });
  const affected = await User.countDocuments({ role: 'moderator', templateName: t.name });
  await recordActivity({
    actor: admin,
    action: 'account.template_updated',
    severity: 'security',
    sentence: `تعديل قالب «${t.name}»${lines.length ? `: ${lines.join('؛ ')}` : ''} (ينطبق على ${affected} حساب بعد التطبيق)`,
    targets: [{ type: 'template', id: t._id, label: t.name }],
    before: summarizePermissions(before),
    after: summarizePermissions(after),
  });
  return { template: shape(t, affected), affected };
}

export async function deleteTemplate(admin, id) {
  const t = await templateOrThrow(id);
  const used = await User.countDocuments({ role: 'moderator', templateName: t.name });
  if (used) throw conflict(`القالب مستخدم في ${used} حساب. غيّر قالب هذه الحسابات أولًا.`, 'TEMPLATE_IN_USE');
  await PermissionTemplate.deleteOne({ _id: t._id });
  await recordActivity({ actor: admin, action: 'account.template_deleted', severity: 'security', sentence: `حذف قالب الصلاحيات «${t.name}»`, targets: [{ type: 'template', label: t.name }] });
  return { deleted: true };
}

/** For each account on this template: what changes if the template is applied (before / after, in words). */
export async function previewApply(id) {
  const t = await templateOrThrow(id);
  const users = await User.find({ role: 'moderator', templateName: t.name }).sort({ name: 1 }).lean();
  const items = users.map((u) => {
    const before = plainPermissions(u.permissions);
    const after = permissionsFromTemplate(t, u.permissions);
    const changes = diffPermissions(before, after);
    return { accountId: String(u._id), name: u.name, status: u.status || 'active', changes, changed: changes.length > 0, before: summarizePermissions(before), after: summarizePermissions(after) };
  });
  return { template: shape(t, users.length), accounts: items, changedCount: items.filter((i) => i.changed).length };
}

/** Apply the template to its accounts (all with changes, or only the chosen ones). */
export async function applyTemplate(admin, id, { accountIds } = {}) {
  const t = await templateOrThrow(id);
  const filter = { role: 'moderator', templateName: t.name };
  if (accountIds?.length) {
    const ids = accountIds.filter((v) => mongoose.isValidObjectId(v));
    if (ids.length !== accountIds.length) throw badRequest('معرّف حساب غير صالح');
    filter._id = { $in: ids };
  }
  const users = await User.find(filter);
  const done = [];
  for (const u of users) {
    const before = plainPermissions(u.permissions);
    const after = permissionsFromTemplate(t, u.permissions);
    if (!diffPermissions(before, after).length) continue;
    u.permissions = after;
    await u.save();
    done.push(u.name);
  }
  await recordActivity({
    actor: admin,
    action: 'account.template_applied',
    severity: 'security',
    sentence: `تطبيق قالب «${t.name}» على ${done.length} حساب${done.length ? `: ${done.join('، ')}` : ''}`,
    targets: [{ type: 'template', id: t._id, label: t.name }],
    after: { accounts: done },
  });
  return { applied: done.length };
}
