import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { usePermissions } from '../features/auth/permissions.js';
import { COUNTED_SECTIONS, NAV_COUNTS_STALE, locate, phoneNav, sectionCount, tabCount, visibleNav } from '../features/nav/sections.js';
import { DemoBanner, Logo } from '../components/ui.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { api } from '../services/api.js';

function NavItem({ to, active, className, children }) {
  return (
    <Link to={to} className={`${className} ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}

const Count = ({ value }) => (value > 0 ? <span className="nav-count">{value}</span> : null);

/** One search box for the whole dashboard: opens the orders list filtered by the text. */
function GlobalSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setText('');
    navigate(`/admin/orders?q=${encodeURIComponent(q)}`);
  };
  return (
    <form className="appbar__search" role="search" onSubmit={submit}>
      <input
        className="input"
        type="search"
        enterKeyHint="search"
        placeholder="رقم الطلب أو التليفون أو الاسم"
        aria-label="بحث في الطلبات"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

export function AdminLayout() {
  const { user, logout, mockMode } = useAuth();
  const perms = usePermissions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // A menu stays open only on the address it was opened on, so navigating closes it.
  const [menu, setMenu] = useState({ name: null, at: '' });
  const openMenu = menu.at === pathname ? menu.name : null;
  const toggle = (name) => setMenu(openMenu === name ? { name: null, at: '' } : { name, at: pathname });
  const close = () => setMenu({ name: null, at: '' });

  useEffect(() => {
    if (!openMenu) return undefined;
    const onKey = (e) => e.key === 'Escape' && setMenu({ name: null, at: '' });
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openMenu]);

  // On a phone the tab row scrolls sideways: bring the open tab into view.
  const subnav = useRef(null);
  useEffect(() => {
    subnav.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  const nav = visibleNav(perms);
  const here = locate(nav, pathname);
  const sections = nav.filter((s) => !s.utility);
  const system = nav.find((s) => s.utility);
  const { bar, more } = phoneNav(nav);

  // Work waiting on someone, shown next to its tab. Each figure follows the permission of its page.
  const navCounts = useAsync(
    () => (COUNTED_SECTIONS.some((s) => perms.can(s)) ? api.get('/admin/nav-counts') : Promise.resolve(null)),
    [pathname],
  );
  const reloadCounts = navCounts.reload;
  useEffect(() => {
    const again = () => reloadCounts({ silent: true });
    window.addEventListener(NAV_COUNTS_STALE, again);
    return () => window.removeEventListener(NAV_COUNTS_STALE, again);
  }, [reloadCounts]);
  const counts = navCounts.data?.counts || {};

  const alerts = user?.role === 'admin' ? user?.security?.unreadAlerts || 0 : 0;
  const unprotected = user?.role === 'admin' && user?.security && !user.security.mfaEnabled;

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const switcher = here.tab && here.tab.pages.length > 1;

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main">
        تخطي إلى المحتوى
      </a>
      <header className="appbar">
        <Link to="/admin" className="appbar__brand" aria-label="الرئيسية">
          <Logo size={56} />
        </Link>
        <nav className="appbar__nav" aria-label="الأقسام">
          {sections.map((s) => (
            <NavItem key={s.key} to={s.to} active={here.section?.key === s.key} className="appbar__link">
              {s.label}
              <Count value={sectionCount(s, counts)} />
            </NavItem>
          ))}
        </nav>
        {perms.can('orders') ? <GlobalSearch /> : <span className="appbar__spacer" />}
        <button
          type="button"
          className={`appbar__settings ${here.section?.key === 'system' ? 'is-active' : ''}`}
          onClick={() => toggle('settings')}
          aria-expanded={openMenu === 'settings'}
          aria-label="الحساب والإعدادات"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
          </svg>
          {alerts > 0 && <span className="nav-count appbar__dot" aria-label="تنبيهات جديدة">{alerts}</span>}
          {!alerts && unprotected && <span className="appbar__dot appbar__dot--warn" aria-label="الحساب غير محمي" />}
        </button>
        {openMenu === 'settings' && (
          <div className="menu menu--settings">
            <div className="menu__user">
              <strong>{user?.name}</strong>
              <span className="muted">{user?.role === 'moderator' ? 'مودريتور' : 'مشرف'}</span>
            </div>
            {system?.tabs.map((tab) => (
              <Link key={tab.to} className="menu__item" to={tab.to} onClick={close}>
                {tab.label}
                {tab.to === '/admin/security' && <Count value={alerts} />}
                {tab.to === '/admin/security' && unprotected && <span className="badge badge--warning">غير محمي</span>}
              </Link>
            ))}
            <button type="button" className="menu__item" onClick={handleLogout}>
              تسجيل الخروج
            </button>
          </div>
        )}
      </header>

      {here.section && here.section.tabs.length > 1 && (
        <nav ref={subnav} className="subnav" aria-label={here.section.label}>
          {here.section.tabs.map((tab) => (
            <NavItem key={tab.to} to={tab.to} active={here.tab === tab} className="subnav__link">
              {tab.label}
              <Count value={tabCount(tab, counts)} />
            </NavItem>
          ))}
        </nav>
      )}

      {mockMode && <DemoBanner />}
      <main id="main" className="admin-content">
        {switcher && (
          <nav className="seg" aria-label={here.tab.label}>
            {here.tab.pages.map((p) => (
              <NavItem key={p.to} to={p.to} active={here.page === p} className="seg__btn">
                {p.label}
                <Count value={counts[p.count]} />
              </NavItem>
            ))}
          </nav>
        )}
        <Outlet />
      </main>

      {openMenu && <div className="menu-backdrop" onClick={close} aria-hidden="true" />}
      <nav className="bottombar" aria-label="القائمة السفلية">
        {bar.map((s) => (
          <NavItem key={s.key} to={s.to} active={here.section?.key === s.key} className="bottombar__link">
            {s.label}
            <Count value={sectionCount(s, counts)} />
          </NavItem>
        ))}
        {more.length > 0 && (
          <button
            type="button"
            className={`bottombar__link ${more.some((s) => s.key === here.section?.key) ? 'is-active' : ''}`}
            onClick={() => toggle('more')}
            aria-expanded={openMenu === 'more'}
          >
            المزيد
          </button>
        )}
      </nav>
      {openMenu === 'more' && (
        <div className="menu menu--more">
          {more.map((s) => (
            <div key={s.key} className="menu__group">
              <span className="menu__title">{s.label}</span>
              {s.tabs.map((tab) => (
                <Link key={tab.to} className="menu__item" to={tab.to} onClick={close}>
                  {tab.label}
                  <Count value={tabCount(tab, counts)} />
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
