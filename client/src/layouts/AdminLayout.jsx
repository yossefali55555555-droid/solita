import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { DemoBanner, Logo } from '../components/ui.jsx';

const NAV = [
  { to: '/admin', label: 'نظرة عامة', end: true },
  { to: '/admin/orders', label: 'الطلبات' },
  { to: '/admin/reviews', label: 'طلبات التسليم بانتظار المراجعة' },
  { to: '/admin/couriers', label: 'المندوبون' },
  { to: '/admin/cash', label: 'النقدية والتسويات' },
  { to: '/admin/sync', label: 'المزامنة مع EasyOrders' },
];

export function AdminLayout() {
  const { user, logout, mockMode } = useAuth();
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
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="sidebar__user">
            <strong>{user?.name}</strong>
            <span className="muted">مشرف</span>
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
          <span className="topbar__title">لوحة المشرف</span>
        </header>
        {mockMode && <DemoBanner />}
        <main id="main" className="admin-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
