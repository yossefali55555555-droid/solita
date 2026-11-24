import {
  DANGEROUS,
  DANGEROUS_KEYS,
  FIELD_KEYS,
  SECTION_KEYS,
  levelAtLeast,
} from '../constants/permissions.js';
import { STAFF_ROLES } from '../constants/statuses.js';

/**
 * Permission checks. Always evaluated on the user loaded from the database
 * for this request (req.user), never on anything sent by the client.
 */

export const isAdmin = (user) => user?.role === 'admin';
export const isStaff = (user) => STAFF_ROLES.includes(user?.role);

function grantActive(grant, now) {
  if (!grant) return false;
  if (grant.until === null || grant.until === undefined) return true;
  return new Date(grant.until).getTime() > now.getTime();
}

/** Section level of a user: 'edit' | 'view' | 'none'. */
export function sectionLevel(user, section) {
  if (!SECTION_KEYS.includes(section)) return 'none';
  if (isAdmin(user)) return 'edit';
  if (user?.role !== 'moderator') return 'none';
  return user.permissions?.sections?.[section] || 'none';
}

export function hasSection(user, section, level = 'view') {
  return levelAtLeast(sectionLevel(user, section), level);
}

/** A dangerous grant only counts together with "edit" on its section. */
export function hasDangerous(user, key) {
  const def = DANGEROUS[key];
  if (!def) return false;
  if (isAdmin(user)) return true;
  if (user?.role !== 'moderator') return false;
  return Boolean(user.permissions?.dangerous?.includes(key)) && hasSection(user, def.section, 'edit');
}

/** Field grant, honouring temporary grants (expired = ignored, no cron needed). */
export function hasField(user, key, now = new Date()) {
  if (!FIELD_KEYS.includes(key)) return false;
  if (isAdmin(user)) return true;
  if (user?.role !== 'moderator') return false;
  return (user.permissions?.fields || []).some((g) => g.key === key && grantActive(g, now));
}

/** Permissions as returned by /auth/me (expired temporary grants removed). */
export function effectivePermissions(user, now = new Date()) {
  if (!isStaff(user)) return null;
  if (isAdmin(user)) {
    return {
      isAdmin: true,
      sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, 'edit'])),
      dangerous: [...DANGEROUS_KEYS],
      fields: FIELD_KEYS.map((key) => ({ key, until: null })),
    };
  }
  const sections = {};
  for (const key of SECTION_KEYS) {
    const level = user.permissions?.sections?.[key];
    if (level) sections[key] = level;
  }
  return {
    isAdmin: false,
    sections,
    dangerous: DANGEROUS_KEYS.filter((k) => hasDangerous(user, k)),
    fields: (user.permissions?.fields || [])
      .filter((g) => FIELD_KEYS.includes(g.key) && grantActive(g, now))
      .map((g) => ({ key: g.key, until: g.until ? new Date(g.until).toISOString() : null })),
  };
}
