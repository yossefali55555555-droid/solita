import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime } from '../../utils/format.js';

export function CourierNotificationsPage() {
  const { data, error, loading, reload } = useAsync(() => api.get('/auth/notifications'), []);

  useEffect(() => {
    if (data?.unread) api.post('/auth/notifications/read').catch(() => {});
  }, [data?.unread]);

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data.items.length) return <EmptyState title="لا توجد إشعارات" />;

  return (
    <ul className="notifications">
      {data.items.map((n) => (
        <li key={n._id} className={`notification ${n.readAt ? '' : 'notification--unread'} notification--${n.type}`}>
          <p>{n.message}</p>
          <div className="row-between">
            <span className="muted small">{formatDateTime(n.createdAt)}</span>
            {n.order && <Link className="link small" to={`/courier/orders/${n.order}`}>عرض الطلب</Link>}
          </div>
        </li>
      ))}
    </ul>
  );
}
