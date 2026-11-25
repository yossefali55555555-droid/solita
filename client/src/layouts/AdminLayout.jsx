import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { usePermissions } from '../features/auth/permissions.js';
import { DemoBanner, Logo } from '../components/ui.jsx';

// Ordered from the most to the least important for the day-to-day work:
// orders and delivery first, then money, then recovering customers, then analytics and marketing, system last.
// `section` = the permission that opens the page; entries the user cannot open are hidden.
const NAV = [
  { to: '/admin', label: 'نظرة عامة', end: true, section: 'dashboard' },
  { to: '/admin/orders', label: 'الطلبات', section: 'orders' },
  { to: '/admin/missed-orders', label: 'الطلبات المفقودة', section: 'missedOrders' },
  { to: '/admin/labels', label: 'طباعة البوليصة', section: 'warehouse' },
  { to: '/admin/reviews', label: 'طلبات التسليم بانتظار المراجعة', section: 'reviews' },
  { to: '/admin/returns', label: 'مراجعة الرفض والمرتجعات', section: 'warehouse' },
  { to: '/admin/couriers', label: 'المندوبون', section: 'couriers' },
  { to: '/admin/cash', label: 'النقدية والتسويات', section: 'cash' },
  { to: '/admin/customers', label: 'العملاء', section: 'customers' },
  { to: '/admin/abandoned-carts', label: 'السلات المتروكة', section: 'storefront' },
  { to: '/admin/finance', label: 'الأرباح والمصروفات', section: 'finance' },
  { to: '/admin/page-time', label: 'حركة الصفحات', section: 'storefront' },
  { to: '/admin/coupons', label: 'الكوبونات', section: 'coupons' },
  { to: '/admin/founders', label: 'أوائل سوليتا', section: 'founders' },
  { to: '/admin/sync', label: 'المزامنة مع EasyOrders', section: 'sync' },
  { to: '/admin/site-settings', label: 'إعدادات الموقع', section: 'siteSettings' },
  { to: '/admin/security', label: 'الأمان والتنبيهات', adminOnly: true },
];

export function AdminLayout() {
  const { user, logout, mockMode } = useAuth();
  const perms = usePermissions();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main">
        تخطي إلى المحتوى
      </a>
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <Logo size={120} />
          <span className="sidebar__product">إدارة الطلبات والمندوبين</span>
        </div>
        <nav className="sidebar__nav" aria-label="القائمة الرئيسية">
          {NAV.filter((item) => (item.adminOnly ? user?.role === 'admin' : perms.can(item.section))).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
              {item.adminOnly && user?.security?.unreadAlerts > 0 && (
                <span className="badge badge--danger" aria-label="تنبيهات جديدة">
                  {' '}
                  {user.security.unreadAlerts}
                </span>
              )}
              {item.adminOnly && user?.security && !user.security.mfaEnabled && (
                <span className="badge badge--warning"> غير محمي</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="sidebar__user">
            <strong>{user?.name}</strong>
            <span className="muted">{user?.role === 'moderator' ? 'مودريتور' : 'مشرف'}</span>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleLogout}>
            تسجيل الخروج
          </button>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}
      <div className="admin-main">
        <header className="topbar">
          <button
            type="button"
            className="topbar__menu"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="فتح القائمة"
          >
            ☰
          </button>
          <Logo size={56} />
          <span className="topbar__title">{user?.role === 'moderator' ? 'لوحة المودريتور' : 'لوحة المشرف'}</span>
        </header>
        {mockMode && <DemoBanner />}
        <main id="main" className="admin-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
