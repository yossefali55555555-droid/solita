/**
 * Admin navigation: a few sections, each holding the pages that belong together.
 * Page URLs are unchanged, so existing links and bookmarks keep working.
 * `section` on a page = the permission that opens it; what the user cannot open is hidden.
 */
export const NAV_SECTIONS = [
  { key: 'home', label: 'الرئيسية', tabs: [{ label: 'الرئيسية', pages: [{ to: '/admin', section: 'dashboard' }] }] },
  {
    key: 'orders',
    label: 'الطلبات',
    home: '/admin/orders',
    // Tabs follow the life of an order.
    tabs: [
      {
        label: 'لم تكتمل',
        pages: [
          { to: '/admin/missed-orders', label: 'مشكلة وقت الطلب', section: 'missedOrders', count: 'missedOrders' },
          { to: '/admin/abandoned-carts', label: 'سلة متروكة', section: 'storefront', count: 'abandonedCarts' },
        ],
      },
      { label: 'كل الطلبات', pages: [{ to: '/admin/orders', section: 'orders' }] },
      { label: 'الطباعة', count: 'labels', pages: [{ to: '/admin/labels', section: 'warehouse' }] },
      { label: 'مراجعة التسليم', count: 'reviews', pages: [{ to: '/admin/reviews', section: 'reviews' }] },
      { label: 'المرتجعات', count: 'returns', pages: [{ to: '/admin/returns', section: 'warehouse' }] },
    ],
  },
  { key: 'couriers', label: 'المناديب', tabs: [{ label: 'المناديب', pages: [{ to: '/admin/couriers', section: 'couriers' }] }] },
  {
    key: 'customers',
    label: 'العملاء',
    tabs: [
      { label: 'العملاء', pages: [{ to: '/admin/customers', section: 'customers' }] },
      { label: 'الكوبونات', pages: [{ to: '/admin/coupons', section: 'coupons' }] },
      { label: 'أوائل سوليتا', pages: [{ to: '/admin/founders', section: 'founders' }] },
    ],
  },
  {
    key: 'money',
    label: 'الفلوس',
    tabs: [
      { label: 'نقدية المناديب', pages: [{ to: '/admin/cash', section: 'cash' }] },
      { label: 'الأرباح والمصروفات', pages: [{ to: '/admin/finance', section: 'finance' }] },
    ],
  },
  {
    key: 'site',
    label: 'الموقع',
    tabs: [
      { label: 'إعدادات الموقع', pages: [{ to: '/admin/site-settings', section: 'siteSettings' }] },
      { label: 'صفحة المقاسات', pages: [{ to: '/admin/size-guide', section: 'siteSettings' }] },
      { label: 'حركة الصفحات', pages: [{ to: '/admin/page-time', section: 'storefront' }] },
    ],
  },
  {
    // Not day-to-day work: opened from the settings button, not the section bar.
    key: 'system',
    label: 'الأمان والمزامنة',
    utility: true,
    tabs: [
      { label: 'الأمان والتنبيهات', pages: [{ to: '/admin/security', adminOnly: true }] },
      { label: 'المزامنة مع EasyOrders', pages: [{ to: '/admin/sync', section: 'sync' }] },
      { label: 'المودريتورز', pages: [{ to: '/admin/staff', adminOnly: true }] },
      { label: 'النشاطات', pages: [{ to: '/admin/activity', adminOnly: true }] },
    ],
  },
];

/** The sections, tabs and pages this user may open, each with the link it leads to. */
export function visibleNav(perms) {
  const allowed = (page) => (page.adminOnly ? perms.isAdmin : perms.can(page.section));
  return NAV_SECTIONS.map((section) => {
    const tabs = section.tabs
      .map((tab) => ({ ...tab, pages: tab.pages.filter(allowed) }))
      .filter((tab) => tab.pages.length)
      .map((tab) => ({ ...tab, to: tab.pages[0].to }));
    const home = tabs.find((tab) => tab.pages.some((p) => p.to === section.home));
    return { ...section, tabs, to: home?.to || tabs[0]?.to };
  }).filter((section) => section.tabs.length);
}

const matches = (pathname, to) =>
  to === '/admin' ? pathname === '/admin' || pathname === '/admin/' : pathname === to || pathname.startsWith(`${to}/`);

/** Which section / tab / page the current address belongs to. */
export function locate(nav, pathname) {
  for (const section of nav) {
    for (const tab of section.tabs) {
      const page = tab.pages.find((p) => matches(pathname, p.to));
      if (page) return { section, tab, page };
    }
  }
  return {};
}

/**
 * The number next to a tab: its own `count`, or the sum of its visible pages'
 * counts (a tab holding several pages). `counts` holds only what the user may see.
 */
export function tabCount(tab, counts = {}) {
  if (tab.count) return counts[tab.count] || 0;
  return tab.pages.reduce((sum, page) => sum + (counts[page.count] || 0), 0);
}

/** The number next to a section: everything waiting in its tabs. */
export function sectionCount(section, counts = {}) {
  return section.tabs.reduce((sum, tab) => sum + tabCount(tab, counts), 0);
}

/** The sections whose counts the user may see (the server checks the same). */
export const COUNTED_SECTIONS = ['missedOrders', 'storefront', 'warehouse', 'reviews'];

const PHONE_BAR = ['home', 'orders', 'couriers', 'money', 'customers', 'site'];

/** Phone bottom bar: the first four sections the user has, everything else under «المزيد». */
export function phoneNav(nav) {
  const bar = PHONE_BAR.map((key) => nav.find((s) => s.key === key)).filter(Boolean).slice(0, 4);
  return { bar, more: nav.filter((s) => !bar.includes(s)) };
}
