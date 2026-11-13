import { Link } from 'react-router-dom';
import { Card, StatCard } from '../../components/ui.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatMoney, formatNumber } from '../../utils/format.js';

/** Small «سلوك الزوار» summary (last 7 days). Hidden quietly if it cannot load. */
export function VisitorBehaviourCard({ showLink = false }) {
  const { data, error } = useAsync(() => api.get('/admin/storefront/summary'), []);
  if (error || !data) return null;
  const c = data.carts7d;
  return (
    <Card
      title="سلوك الزوار (آخر 7 أيام)"
      actions={
        showLink ? (
          <Link className="link" to="/admin/abandoned-carts">
            السلات المتروكة ←
          </Link>
        ) : null
      }
    >
      <div className="stats-grid stats-grid--compact">
        <StatCard label="زوار اليوم" value={formatNumber(data.visitorsToday)} />
        <StatCard label="زوار آخر 7 أيام" value={formatNumber(data.visitors7d)} tone="info" />
        <StatCard
          label="سلات متروكة"
          value={formatNumber(c.open + c.contacted)}
          tone="warning"
          hint={formatMoney(c.abandonedValue)}
        />
        <StatCard label="سلات تحولت لطلبات" value={formatNumber(c.converted)} tone="success" />
      </div>
      <div className="behaviour-lists">
        <div>
          <h3 className="section-title">الأكثر مشاهدة</h3>
          {data.topViewed.length ? (
            <ol className="simple-list">
              {data.topViewed.map((p) => (
                <li key={p.slug}>
                  {p.name || p.slug}{' '}
                  <span className="muted small">
                    ({formatNumber(p.views)} مشاهدة، {formatNumber(p.adds)} إضافة)
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">لا توجد بيانات بعد</p>
          )}
        </div>
        <div>
          <h3 className="section-title">أُضيف للسلة ولم يُشترَ</h3>
          {data.addedNotBought.length ? (
            <ol className="simple-list">
              {data.addedNotBought.map((p) => (
                <li key={p.slug}>
                  {p.name || p.slug}{' '}
                  <span className="muted small">
                    ({formatNumber(p.carts)} سلة، {formatMoney(p.value)})
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">لا توجد بيانات بعد</p>
          )}
        </div>
      </div>
    </Card>
  );
}
