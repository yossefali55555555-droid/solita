import { describe, expect, it } from 'vitest';
import { permissionsOf, ADMIN_PAGES } from '../auth/permissions.js';
import { locate, NAV_SECTIONS, phoneNav, visibleNav } from './sections.js';

const admin = permissionsOf({ role: 'admin' });
const moderator = (sections) => permissionsOf({ role: 'moderator', permissions: { sections } });
const keys = (list) => list.map((s) => s.key);
const routes = (nav) => nav.flatMap((s) => s.tabs.flatMap((t) => t.pages.map((p) => p.to)));

describe('admin navigation', () => {
  it('still reaches every admin page, each from one place only', () => {
    const all = routes(NAV_SECTIONS);
    expect(new Set(all).size).toBe(all.length);
    for (const page of ADMIN_PAGES) expect(all).toContain(page.to);
    expect(all).toContain('/admin/security');
    expect(all).toContain('/admin/size-guide');
  });

  it('puts missed orders and abandoned carts inside orders, which opens on all orders', () => {
    const orders = visibleNav(admin).find((s) => s.key === 'orders');
    expect(orders.to).toBe('/admin/orders');
    expect(orders.tabs[0].pages.map((p) => p.to)).toEqual(['/admin/missed-orders', '/admin/abandoned-carts']);
  });

  it('shows a moderator only what the permissions open', () => {
    const nav = visibleNav(moderator({ orders: 'view', warehouse: 'edit' }));
    expect(keys(nav)).toEqual(['orders']);
    expect(nav[0].tabs.map((t) => t.label)).toEqual(['كل الطلبات', 'الطباعة', 'المرتجعات']);
  });

  it('opens the first allowed tab and hides empty sections', () => {
    const nav = visibleNav(moderator({ storefront: 'view' }));
    expect(keys(nav)).toEqual(['orders', 'site']);
    expect(nav[0].to).toBe('/admin/abandoned-carts');
    expect(visibleNav(moderator({}))).toEqual([]);
  });

  it('knows where a detail page belongs', () => {
    const nav = visibleNav(admin);
    expect(locate(nav, '/admin/orders/123').section.key).toBe('orders');
    expect(locate(nav, '/admin/reviews/9').tab.label).toBe('مراجعة التسليم');
    expect(locate(nav, '/admin').section.key).toBe('home');
    expect(locate(nav, '/admin/unknown')).toEqual({});
  });

  it('keeps four sections on the phone bar and the rest under more', () => {
    const { bar, more } = phoneNav(visibleNav(admin));
    expect(keys(bar)).toEqual(['home', 'orders', 'couriers', 'money']);
    expect(keys(more)).toEqual(['customers', 'site', 'system']);
  });
});
