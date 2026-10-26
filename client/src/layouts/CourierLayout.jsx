import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { DemoBanner, Logo } from '../components/ui.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { api } from '../services/api.js';

export function CourierLayout() {
  const { user, logout, mockMode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Refresh the unread counter whenever the courier navigates.
  const { data } = useAsync(() => api.get('/auth/notifications'), [location.pathname]);
  const unread = data?.unread || 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="courier-shell">
      <header className="courier-header">
        <Logo size={60} />
        <div className="courier-header__who">
          <strong>{user?.name}</strong>
          <span className="muted">مندوب توصيل</span>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleLogout}>
          خروج
        </button>
      </header>
      {mockMode && <DemoBanner />}
      <main className="courier-content" id="main">
        <Outlet />
      </main>
      <nav className="courier-nav" aria-label="قائمة المندوب">
        <NavLink to="/courier" end className={({ isActive }) => `courier-nav__link ${isActive ? 'is-active' : ''}`}>
          طلباتي
        </NavLink>
        <NavLink to="/courier/cash" className={({ isActive }) => `courier-nav__link ${isActive ? 'is-active' : ''}`}>
          النقدية
        </NavLink>
        <NavLink to="/courier/notifications" className={({ isActive }) => `courier-nav__link ${isActive ? 'is-active' : ''}`}>
          الإشعارات
          {unread > 0 && <span className="courier-nav__count">{unread}</span>}
        </NavLink>
      </nav>
    </div>
  );
}
