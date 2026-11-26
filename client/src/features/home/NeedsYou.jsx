import { Link } from 'react-router-dom';
import { Card } from '../../components/ui.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatNumber } from '../../utils/format.js';
import { usePermissions } from '../auth/permissions.js';

const quietly = (allowed, path, query) => (allowed ? api.get(path, query) : Promise.resolve(null));

/** «محتاجك»: the work waiting on someone, first thing on the home page. */
export function NeedsYou({ stats }) {
  const perms = usePermissions();
  const missed = useAsync(() => quietly(perms.can('missedOrders'), '/admin/missed-orders', { limit: 1 }), []);
  const storefront = useAsync(() => quietly(perms.can('storefront'), '/admin/storefront/summary'), []);

  const { orders, sync, pendingReviews } = stats;
  // `count` is undefined when the user may not see that figure.
  const rows = [
    { section: 'reviews', title: 'مراجعة التسليم', hint: 'المندوب أكد التسليم ومستني الموافقة', count: pendingReviews, to: '/admin/reviews', action: 'راجع' },
    { section: 'warehouse', title: 'رفض ومرتجعات', hint: 'محاولات فشلت ومحتاجة قرار', count: orders?.failed, to: '/admin/returns', action: 'افتح' },
    { section: 'orders', title: 'طلبات من غير مندوب', hint: 'محتاجة تتعيّن', count: orders?.unassigned, to: '/admin/orders?courier=unassigned', action: 'عيّن' },
    { section: 'missedOrders', title: 'مشكلة وقت الطلب', hint: 'عملاء لسه ما اتواصلناش معاهم', count: missed.data?.counts?.open, to: '/admin/missed-orders', action: 'تواصل' },
    { section: 'storefront', title: 'سلات متروكة', hint: 'آخر 7 أيام ولسه ما اتواصلناش', count: storefront.data?.carts7d?.open, to: '/admin/abandoned-carts', action: 'تواصل' },
    { section: 'sync', title: 'أخطاء المزامنة', hint: 'تحديثات ما وصلتش EasyOrders', count: sync ? sync.failures + sync.webhookFailures : undefined, to: '/admin/sync', action: 'شوف' },
  ].filter((r) => perms.can(r.section) && r.count > 0);

  const loading = missed.loading || storefront.loading;
  const failed = missed.error || storefront.error;

  return (
    <Card title="محتاجك">
      {rows.length > 0 && (
        <ul className="needs">
          {rows.map((r) => (
            <li key={r.to} className="needs__row">
              <span className="needs__count">{formatNumber(r.count)}</span>
              <span className="needs__text">
                <strong>{r.title}</strong>
                <span className="muted small">{r.hint}</span>
              </span>
              <Link className="btn btn--secondary" to={r.to}>
                {r.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!rows.length && !loading && !failed && <p className="muted">مفيش حاجة مستنياك دلوقتي.</p>}
      {failed && <p className="muted small">تعذر تحميل جزء من القايمة، حدّث الصفحة.</p>}
    </Card>
  );
}
