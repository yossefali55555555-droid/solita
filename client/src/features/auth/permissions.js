import { useMemo } from 'react';
import { useAuth } from './AuthContext.jsx';

/**
 * Permission helpers built from `permissions` in /auth/me. They only decide
 * what the interface shows: every API request is checked again on the server,
 * which is the real authority.
 */

const RANK = { none: 0, view: 1, edit: 2 };

export function permissionsOf(user) {
  const p = user?.permissions;
  const isAdmin = user?.role === 'admin' || Boolean(p?.isAdmin);
  return {
    isAdmin,
    /** Section level check: can('orders') = view or more; can('orders', 'edit'). */
    can(section, level = 'view') {
      if (isAdmin) return true;
      return (RANK[p?.sections?.[section] || 'none'] ?? 0) >= RANK[level];
    },
    /** Dangerous grant (also needs edit on its section, which the server enforces). */
    danger(key) {
      return isAdmin || Boolean(p?.dangerous?.includes(key));
    },
    /** Field grant; a temporary one is ignored once it has expired. */
    field(key) {
      if (isAdmin) return true;
      return (p?.fields || []).some((g) => g.key === key && (!g.until || new Date(g.until).getTime() > Date.now()));
    },
  };
}

export function usePermissions() {
  const { user } = useAuth();
  return useMemo(() => permissionsOf(user), [user]);
}

/** Admin pages in menu order: the section that opens each one. */
export const ADMIN_PAGES = [
  { to: '/admin', section: 'dashboard', end: true },
  { to: '/admin/orders', section: 'orders' },
  { to: '/admin/missed-orders', section: 'missedOrders' },
  { to: '/admin/labels', section: 'warehouse' },
  { to: '/admin/reviews', section: 'reviews' },
  { to: '/admin/returns', section: 'warehouse' },
  { to: '/admin/couriers', section: 'couriers' },
  { to: '/admin/cash', section: 'cash' },
  { to: '/admin/customers', section: 'customers' },
  { to: '/admin/abandoned-carts', section: 'storefront' },
  { to: '/admin/finance', section: 'finance' },
  { to: '/admin/page-time', section: 'storefront' },
  { to: '/admin/coupons', section: 'coupons' },
  { to: '/admin/founders', section: 'founders' },
  { to: '/admin/sync', section: 'sync' },
  { to: '/admin/site-settings', section: 'siteSettings' },
];

/** First admin page the user may open (landing page for a moderator without the dashboard). */
export function firstAllowedPage(perms) {
  return ADMIN_PAGES.find((p) => perms.can(p.section))?.to || null;
}
