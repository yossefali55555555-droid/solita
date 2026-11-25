import { Router } from 'express';
import { DANGEROUS, FIELD_KEYS, LEVELS, SECTION_KEYS } from '../constants/permissions.js';
import { hasDangerous, hasField, hasSection, isAdmin, isStaff } from '../services/permissionService.js';
import { FULL_VIEWER, guardResponse, viewerFor } from '../services/visibilityService.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Per-route permission metadata + enforcement for /api/admin.
 *
 * Every staff route must start with exactly one of:
 *   adminOnly(...)          administrator only (never grantable: init-db)
 *   requirePermission(...)  section level (+ dangerous / field grants)
 *
 * Both take the same arguments. A route registered without metadata is
 * denied to everyone, admin included (default deny), and the route-permission
 * test fails. After a route passes, `req.viewer` says which fields the user
 * may see and the response is guarded (services/visibilityService.js).
 */

export const PERMISSION_META = Symbol.for('solita.permissionMeta');
export const ROUTER_SCOPE = Symbol.for('solita.routerScope');

function assertPlan(section, level, opts) {
  const sections = Array.isArray(section) ? section : [section];
  for (const s of sections) if (!SECTION_KEYS.includes(s)) throw new Error(`Unknown permission section "${s}"`);
  if (!LEVELS.includes(level)) throw new Error(`Unknown permission level "${level}"`);
  if (opts.dangerous && !DANGEROUS[opts.dangerous]) throw new Error(`Unknown dangerous permission "${opts.dangerous}"`);
  for (const f of opts.fields || []) if (!FIELD_KEYS.includes(f)) throw new Error(`Unknown field permission "${f}"`);
  for (const [s, l] of Object.entries(opts.also || {})) assertPlan(s, l, {});
}

function describe(section, level, opts) {
  if (section === undefined) return null;
  assertPlan(section, level, opts);
  return {
    sections: Array.isArray(section) ? [...section] : [section],
    level,
    dangerous: opts.dangerous || null,
    fields: [...(opts.fields || [])],
    also: { ...(opts.also || {}) },
  };
}

/** Staff gate shared by both forms: the role comes from the database user. */
function staffGate(req) {
  if (!req.user) return unauthorized();
  if (!isStaff(req.user)) return forbidden();
  return null;
}

/**
 * Administrator only. Optional arguments record the planned moderator
 * permission (used by phase 2 and checked against the catalog at boot).
 */
export function adminOnly(section, level, opts = {}) {
  const meta = { adminOnly: true, plan: describe(section, level, opts) };
  const mw = function adminOnlyPermission(req, _res, next) {
    const denied = staffGate(req);
    if (denied) return next(denied);
    if (!isAdmin(req.user)) return next(forbidden());
    req.permission = meta;
    req.viewer = FULL_VIEWER;
    next();
  };
  mw[PERMISSION_META] = meta;
  return mw;
}

/**
 * Section permission. `section` may be an array (any one of them is enough).
 * opts.dangerous: dangerous grant key (requires "edit" on its section too).
 * opts.fields: field grants that are mandatory for this route.
 * opts.also: extra sections required, e.g. { orders: 'view' }.
 */
export function requirePermission(section, level, opts = {}) {
  const plan = describe(section, level, opts);
  const meta = { adminOnly: false, plan };
  const mw = function sectionPermission(req, res, next) {
    const denied = staffGate(req);
    if (denied) return next(denied);
    req.permission = meta;
    const user = req.user;
    const now = new Date();
    req.viewer = viewerFor(user, now);
    if (isAdmin(user)) return next();
    if (!plan.sections.some((s) => hasSection(user, s, plan.level))) return next(forbidden());
    for (const [s, l] of Object.entries(plan.also)) if (!hasSection(user, s, l)) return next(forbidden());
    if (plan.dangerous && !hasDangerous(user, plan.dangerous)) return next(forbidden());
    for (const f of plan.fields) if (!hasField(user, f, now)) return next(forbidden());
    guardResponse(res, req.viewer);
    next();
  };
  mw[PERMISSION_META] = meta;
  return mw;
}

export function hasPermissionMeta(fn) {
  return Boolean(fn && fn[PERMISSION_META]);
}

const UNMAPPED = { adminOnly: true, unmapped: true, plan: null };
function denyUnmapped(_req, _res, next) {
  next(forbidden());
}

/**
 * Router for staff routes. Each route must pass a permission middleware as
 * its first handler; otherwise the route is replaced by a deny-all (403 for
 * everyone) and an error is logged at startup.
 */
export function staffRouter() {
  const router = Router();
  router[ROUTER_SCOPE] = 'staff';
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => {
      if (!hasPermissionMeta(handlers[0])) {
        logger.error('Staff route registered without permission metadata; denied for everyone', { method, path });
        return original(path, denyUnmapped);
      }
      return original(path, ...handlers);
    };
  }
  return router;
}
denyUnmapped[PERMISSION_META] = UNMAPPED;

/** Tag a router so the route-permission test knows which area it belongs to. */
export function tagRouter(router, scope) {
  router[ROUTER_SCOPE] = scope;
  return router;
}
