import {
  DANGEROUS,
  DANGEROUS_KEYS,
  FIELDS,
  FIELD_KEYS,
  LEVELS,
  LEVEL_LABELS,
  SECTIONS,
  SECTION_KEYS,
  TEMPORARY_GRANT_PRESETS,
} from '../constants/permissions.js';
import { badRequest } from '../utils/errors.js';

/**
 * Helpers for editing a moderator's permission set (phase 4): normalize what
 * the admin sends, compare two sets in words, copy a template onto an account.
 * Shape (same as User.permissions):
 *   { sections: { orders: 'edit' }, dangerous: ['clearOrders'], fields: [{ key, until }] }
 */

const MAX_TEMPORARY_MS = 366 * 24 * 60 * 60 * 1000;

/** Validate and normalize a permission set (throws a 400 with an Arabic message). */
export function normalizePermissions(input = {}, { now = new Date() } = {}) {
  const sections = {};
  for (const [key, level] of Object.entries(input.sections || {})) {
    if (!SECTION_KEYS.includes(key)) throw badRequest(`قسم غير معروف: ${key}`);
    if (level === 'none' || level === undefined || level === null) continue;
    if (!LEVELS.includes(level)) throw badRequest(`مستوى غير صالح للقسم ${SECTIONS[key].label}`);
    sections[key] = level;
  }
  const dangerous = [...new Set(input.dangerous || [])];
  for (const key of dangerous) {
    if (!DANGEROUS_KEYS.includes(key)) throw badRequest(`تصريح خطر غير معروف: ${key}`);
    const def = DANGEROUS[key];
    if (sections[def.section] !== 'edit') {
      throw badRequest(`تصريح «${def.label}» يتطلب «تعديل» على قسم ${SECTIONS[def.section].label}`);
    }
  }
  const fields = [];
  const seen = new Set();
  for (const grant of input.fields || []) {
    const key = typeof grant === 'string' ? grant : grant?.key;
    if (!FIELD_KEYS.includes(key)) throw badRequest(`تصريح حقل غير معروف: ${key}`);
    if (seen.has(key)) continue;
    seen.add(key);
    let until = typeof grant === 'string' ? null : grant.until ?? null;
    if (until !== null) {
      if (!FIELDS[key].temporary) throw badRequest(`تصريح «${FIELDS[key].label}» لا يُمنح مؤقتًا`);
      until = new Date(until);
      if (Number.isNaN(until.getTime())) throw badRequest('تاريخ انتهاء المنح غير صالح');
      if (until <= now) throw badRequest('تاريخ انتهاء المنح يجب أن يكون في المستقبل');
      if (until.getTime() - now.getTime() > MAX_TEMPORARY_MS) throw badRequest('أقصى مدة للمنح المؤقت سنة');
    }
    fields.push({ key, until });
  }
  return { sections, dangerous, fields };
}

/** The end time of a temporary grant: a preset (hour/day/week) or an explicit date. */
export function grantUntil({ duration, until }, now = new Date()) {
  if (duration && TEMPORARY_GRANT_PRESETS[duration]) return new Date(now.getTime() + TEMPORARY_GRANT_PRESETS[duration]);
  if (duration === 'custom' && until) return new Date(until);
  throw badRequest('اختر مدة المنح: ساعة أو يوم أو أسبوع أو تاريخًا محددًا');
}

/** Plain copy of a stored permission set, active grants only (expired ones are dropped). */
export function plainPermissions(permissions, now = new Date()) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    const level = permissions?.sections?.[key];
    if (level) sections[key] = level;
  }
  const fields = (permissions?.fields || [])
    .filter((g) => FIELD_KEYS.includes(g.key) && (!g.until || new Date(g.until) > now))
    .map((g) => ({ key: g.key, until: g.until ? new Date(g.until) : null }));
  return { sections, dangerous: [...(permissions?.dangerous || [])], fields };
}

/** What copying a template onto an account gives: the template, plus any still-active temporary grant the template lacks. */
export function permissionsFromTemplate(template, current, now = new Date()) {
  const base = {
    sections: { ...(template.sections?.toObject ? template.sections.toObject() : template.sections || {}) },
    dangerous: [...(template.dangerous || [])],
    fields: (template.fields || []).map((key) => ({ key, until: null })),
  };
  for (const grant of plainPermissions(current, now).fields) {
    if (grant.until && !base.fields.some((f) => f.key === grant.key)) base.fields.push(grant);
  }
  return normalizePermissions(base, { now });
}

const fieldText = (g) => `${FIELDS[g.key].label}${g.until ? ` (حتى ${new Date(g.until).toISOString().slice(0, 16).replace('T', ' ')})` : ''}`;

/** Differences between two permission sets as Arabic lines (empty = no change). */
export function diffPermissions(before, after) {
  const lines = [];
  for (const key of SECTION_KEYS) {
    const a = before?.sections?.[key] || 'none';
    const b = after?.sections?.[key] || 'none';
    if (a !== b) lines.push(`${SECTIONS[key].label}: من «${LEVEL_LABELS[a]}» إلى «${LEVEL_LABELS[b]}»`);
  }
  const bd = new Set(before?.dangerous || []);
  const ad = new Set(after?.dangerous || []);
  for (const key of DANGEROUS_KEYS) {
    if (!bd.has(key) && ad.has(key)) lines.push(`منح «${DANGEROUS[key].label}»`);
    if (bd.has(key) && !ad.has(key)) lines.push(`سحب «${DANGEROUS[key].label}»`);
  }
  for (const key of FIELD_KEYS) {
    const a = (before?.fields || []).find((g) => g.key === key);
    const b = (after?.fields || []).find((g) => g.key === key);
    const sameUntil = (a?.until ? new Date(a.until).getTime() : null) === (b?.until ? new Date(b.until).getTime() : null);
    if (!a && b) lines.push(`منح ${fieldText(b)}`);
    else if (a && !b) lines.push(`سحب «${FIELDS[key].label}»`);
    else if (a && b && !sameUntil) lines.push(`تغيير مدة ${FIELDS[key].label}`);
  }
  return lines;
}

/** A compact object for before/after in the activity log. */
export function summarizePermissions(p) {
  return {
    sections: Object.fromEntries(Object.entries(p?.sections || {}).map(([k, v]) => [k, v])),
    dangerous: [...(p?.dangerous || [])],
    fields: (p?.fields || []).map((g) => (g.until ? `${g.key}@${new Date(g.until).toISOString().slice(0, 16)}` : g.key)),
  };
}
