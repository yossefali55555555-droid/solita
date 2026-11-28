import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Badge, Button, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useAuth } from '../../features/auth/AuthContext.jsx';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime } from '../../utils/format.js';

const GROUPS = {
  auth: 'الدخول وكلمة السر',
  account: 'إدارة الحسابات',
  order: 'الطلبات',
  courier: 'المناديب',
  delivery: 'التسليم والمرتجعات',
  cash: 'الخزنة',
  finance: 'الماليات',
  coupon: 'الكوبونات',
  whatsapp: 'واتساب',
  storefront: 'المتجر والطلبات الفائتة',
  settings: 'الإعدادات',
  export: 'التصدير',
  sync: 'المزامنة',
};
const SEVERITY = { normal: ['neutral', 'عادي'], danger: ['warning', 'خطر'], security: ['danger', 'أمني'] };
const ROLE_TABS = [['', 'الكل'], ['moderator', 'المودريتورز'], ['courier', 'المناديب'], ['admin', 'الأدمن']];

function formatBytes(n) {
  if (!n) return '0';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The administrator's activity page: one Arabic line per action, a tab per kind of account, filters, pages. */
export function ActivityPage() {
  const { user } = useAuth();
  const [role, setRole] = useState('');
  const [actor, setActor] = useState('');
  const [group, setGroup] = useState('');
  const [severity, setSeverity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const text = useDebouncedValue(q);

  const actors = useAsync(() => api.get('/admin/activity/actors'), []);
  const { data, error, loading, reload } = useAsync(
    () =>
      api.get('/admin/activity', {
        role,
        actor,
        group,
        severity,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
        q: text,
        page,
        limit: 30,
      }),
    [role, actor, group, severity, from, to, text, page],
  );
  if (user?.role !== 'admin') return <Navigate to="/admin" replace />;

  const reset = (fn) => (e) => {
    fn(e.target.value);
    setPage(1);
  };
  const people = (actors.data?.items || []).filter((a) => !role || a.role === role);
  const pagination = data && { page: data.page, limit: data.limit, total: data.total, pages: Math.max(1, Math.ceil(data.total / data.limit)) };

  return (
    <>
      <PageHeader title="النشاطات" subtitle="سطر واحد لكل إجراء: من فعل ماذا ومتى" actions={<Button variant="secondary" onClick={() => reload()}>تحديث</Button>} />
      <div className="ptabs ptabs--1" role="tablist" aria-label="نوع الحساب">
        {ROLE_TABS.map(([key, label]) => (
          <button
            key={key || 'all'}
            type="button"
            role="tab"
            aria-selected={role === key}
            className={`ptabs__btn ${role === key ? 'is-active' : ''}`}
            onClick={() => {
              setRole(key);
              setActor('');
              setPage(1);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Card>
        <div className="filters">
          <select className="input" aria-label="الحساب" value={actor} onChange={reset(setActor)}>
            <option value="">كل الحسابات</option>
            {people.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="input" aria-label="نوع الإجراء" value={group} onChange={reset(setGroup)}>
            <option value="">كل الأنواع</option>
            {Object.entries(GROUPS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <select className="input" aria-label="الأهمية" value={severity} onChange={reset(setSeverity)}>
            <option value="">كل المستويات</option>
            {Object.entries(SEVERITY).map(([k, [, label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input className="input" type="date" aria-label="من تاريخ" value={from} onChange={reset(setFrom)} />
          <input className="input" type="date" aria-label="إلى تاريخ" value={to} onChange={reset(setTo)} />
          <input className="input filters__search" type="search" placeholder="بحث داخل النص" aria-label="بحث" value={q} onChange={reset(setQ)} />
        </div>
      </Card>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد نشاطات بهذه المواصفات" />
        ) : (
          <ul className="activity-list">
            {data.items.map((row) => (
              <li key={row.id} className="activity-row">
                <div className="activity-row__main">
                  <span className="activity-row__time muted">{formatDateTime(row.at)}</span>
                  <span className="activity-row__text">
                    <strong>{row.actor.name}</strong> — {row.sentence}
                  </span>
                  <span className="activity-row__meta">
                    <Badge tone={SEVERITY[row.severity]?.[0]}>{SEVERITY[row.severity]?.[1]}</Badge>
                    {row.targets.map((t, i) =>
                      t.link ? (
                        <Link key={i} className="link" to={t.link}>فتح {t.label || ''}</Link>
                      ) : t.deleted ? (
                        <Badge key={i} tone="muted" title={t.label || ''}>محذوف: {t.label}</Badge>
                      ) : null,
                    )}
                    {(row.before || row.after) && (
                      <button type="button" className="link-btn" onClick={() => setOpen(open === row.id ? null : row.id)}>
                        {open === row.id ? 'إخفاء التفاصيل' : 'قبل وبعد'}
                      </button>
                    )}
                  </span>
                </div>
                {open === row.id && (
                  <div className="activity-row__diff">
                    {row.before && <pre dir="ltr">قبل: {JSON.stringify(row.before, null, 2)}</pre>}
                    {row.after && <pre dir="ltr">بعد: {JSON.stringify(row.after, null, 2)}</pre>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pagination pagination={pagination} onPage={setPage} />
      </Card>
      {actors.data?.storage && (
        <p className="muted">
          السجل: {actors.data.storage.rows} سطرًا، حوالي {formatBytes(actors.data.storage.dataBytes + actors.data.storage.indexBytes)} في قاعدة البيانات. الأسطر العادية تُحذف تلقائيًا بعد 90 يومًا، والخطرة والأمنية بعد سنة.
        </p>
      )}
    </>
  );
}
