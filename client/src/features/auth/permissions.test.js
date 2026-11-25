import { describe, expect, it } from 'vitest';
import { firstAllowedPage, permissionsOf } from './permissions.js';

const moderator = (permissions) => ({ role: 'moderator', permissions: { isAdmin: false, sections: {}, dangerous: [], fields: [], ...permissions } });

describe('permissionsOf', () => {
  it('lets the administrator through everywhere', () => {
    const p = permissionsOf({ role: 'admin', permissions: { isAdmin: true } });
    expect(p.can('cash', 'edit')).toBe(true);
    expect(p.danger('resetCash')).toBe(true);
    expect(p.field('customerPhone')).toBe(true);
    expect(p.isAdmin).toBe(true);
  });

  it('treats a missing section as none, view as view and edit as view + edit', () => {
    const p = permissionsOf(moderator({ sections: { orders: 'edit', customers: 'view' } }));
    expect(p.can('orders')).toBe(true);
    expect(p.can('orders', 'edit')).toBe(true);
    expect(p.can('customers')).toBe(true);
    expect(p.can('customers', 'edit')).toBe(false);
    expect(p.can('cash')).toBe(false);
  });

  it('checks dangerous grants and honours a temporary field grant until it expires', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const p = permissionsOf(moderator({ dangerous: ['markTest'], fields: [{ key: 'customerPhone', until: soon }, { key: 'export', until: past }, { key: 'moneyFigures', until: null }] }));
    expect(p.danger('markTest')).toBe(true);
    expect(p.danger('clearOrders')).toBe(false);
    expect(p.field('customerPhone')).toBe(true);
    expect(p.field('export')).toBe(false);
    expect(p.field('moneyFigures')).toBe(true);
  });

  it('shows nothing for a user without permissions', () => {
    const p = permissionsOf({ role: 'moderator' });
    expect(p.can('orders')).toBe(false);
    expect(p.field('customerPhone')).toBe(false);
  });
});

describe('firstAllowedPage', () => {
  it('lands a moderator without the dashboard on the first page they may open', () => {
    expect(firstAllowedPage(permissionsOf(moderator({ sections: { customers: 'view', orders: 'view' } })))).toBe('/admin/orders');
    expect(firstAllowedPage(permissionsOf(moderator({})))).toBeNull();
  });
});
