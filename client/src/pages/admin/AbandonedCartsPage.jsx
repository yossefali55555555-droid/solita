import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, formatMoney, formatNumber, orderNumber } from '../../utils/format.js';
import { whatsappLink } from '../../features/whatsapp/whatsapp.js';
import { cartWhatsappMessage } from '../../features/storefront/cartMessage.js';
import { VisitorBehaviourCard } from '../../features/storefront/VisitorBehaviourCard.jsx';

const RANGES = [
  { value: 'today', label: 'اليوم' },
  { value: '3d', label: 'آخر 3 أيام' },
  { value: '7d', label: 'آخر 7 أيام' },
  { value: '30d', label: 'آخر 30 يومًا' },
  { value: 'all', label: 'الكل' },
];
const STATUSES = [
  { value: 'active', label: 'متروكة (لم تكتمل)' },
  { value: 'converted', label: 'تحولت لطلب' },
  { value: 'expired', label: 'منتهية / تم تجاهلها' },
  { value: 'all', label: 'كل الحالات' },
];
const STATUS_BADGE = {
  open: ['warning', 'لم يُتواصل بعد'],
  contacted: ['info', 'تم التواصل'],
  converted: ['success', 'تحولت لطلب'],
  expired: ['muted', 'منتهية'],
};

export function AbandonedCartsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || '7d';
  const status = params.get('status') || 'active';
  const hasPhone = params.get('hasPhone') === 'true';
  const notContacted = params.get('notContacted') === 'true';
  const page = params.get('page') || '1';
  const [busy, setBusy] = useState(null);

  const { data, error, loading, reload } = useAsync(
    () =>
      api.get('/admin/storefront/carts', {
        range,
        status,
        hasPhone: hasPhone ? 'true' : undefined,
        notContacted: notContacted ? 'true' : undefined,
        page,
        limit: 20,
      }),
    [range, status, hasPhone, notContacted, page],
  );
  const settings = useAsync(() => api.get('/admin/site-settings'), []);
  const template = settings.data?.settings?.admin?.cartWhatsappTemplate;

  const update = (next) => {
    const merged = {
      range,
      status,
      hasPhone: hasPhone ? 'true' : '',
      notContacted: notContacted ? 'true' : '',
      ...next,
    };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, v]) => v)));
  };

  const act = async (cart, action) => {
    setBusy(`${cart._id}:${action}`);
    try {
      await api.post(`/admin/storefront/carts/${cart._id}/${action}`);
      toast.success(action === 'contacted' ? 'تم تسجيل التواصل' : 'تم تجاهل السلة');
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="السلات المتروكة"
        subtitle="سلات من الموقع لم تكتمل كطلب. يظهر الرقم إذا كتبه العميل في صفحة إتمام الطلب، وتتحول السلة لطلب تلقائيًا عند وصول طلب من EasyOrders بنفس الرقم."
      />
      <VisitorBehaviourCard />
      <Card>
        <div className="filters">
          <select className="input" aria-label="الفترة" value={range} onChange={(e) => update({ range: e.target.value, page: '' })}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <select className="input" aria-label="الحالة" value={status} onChange={(e) => update({ status: e.target.value, page: '' })}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={hasPhone}
              onChange={(e) => update({ hasPhone: e.target.checked ? 'true' : '', page: '' })}
            />
            فيها رقم هاتف
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={notContacted}
              onChange={(e) => update({ notContacted: e.target.checked ? 'true' : '', page: '' })}
            />
            لم يُتواصل معها بعد
          </label>
        </div>
      </Card>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد سلات مطابقة" description="ستظهر السلات هنا بعد ربط الموقع بالنظام." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>المنتجات</th>
                  <th>القيمة</th>
                  <th>العميل</th>
                  <th>آخر نشاط</th>
                  <th>الحالة</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((cart) => {
                  const [tone, label] = STATUS_BADGE[cart.status] || ['neutral', cart.status];
                  const phone = cart.customer?.phoneNormalized || cart.customer?.phone;
                  const wa = phone ? whatsappLink(phone, cartWhatsappMessage(cart, template)) : '';
                  const active = ['open', 'contacted'].includes(cart.status);
                  return (
                    <tr key={cart._id}>
                      <td>
                        <ul className="simple-list">
                          {cart.items.map((i) => (
                            <li key={`${i.slug}|${i.size}`}>
                              {i.name || i.slug}
                              {i.size ? <span className="muted small"> · مقاس {i.size}</span> : null}
                              {i.qty > 1 ? <span className="muted small"> × {i.qty}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="nowrap">
                        {formatMoney(cart.value)}
                        <div className="muted small">{formatNumber(cart.itemsCount)} قطعة</div>
                      </td>
                      <td>
                        {cart.customer?.name || <span className="muted">—</span>}
                        {phone ? (
                          <div className="muted mono small" dir="ltr">
                            {phone}
                          </div>
                        ) : (
                          <div className="muted small">بدون رقم</div>
                        )}
                      </td>
                      <td className="nowrap muted">
                        {formatDateTime(cart.lastActivityAt)}
                        {cart.lastSeenAt && cart.lastSeenAt !== cart.lastActivityAt ? (
                          <div className="small">آخر زيارة: {formatDateTime(cart.lastSeenAt)}</div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                        {cart.contactedAt ? (
                          <div className="muted small">
                            {formatDateTime(cart.contactedAt)}
                            {cart.contactedBy?.name ? ` · ${cart.contactedBy.name}` : ''}
                          </div>
                        ) : null}
                        {cart.status === 'converted' && cart.convertedOrder ? (
                          <div className="muted small">طلب {orderNumber(cart.convertedOrder)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className="badge-row">
                          {wa && active ? (
                            <a className="btn btn--whatsapp btn--sm" href={wa} target="_blank" rel="noopener noreferrer">
                              واتساب
                            </a>
                          ) : null}
                          {active ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={busy === `${cart._id}:contacted`}
                                onClick={() => act(cart, 'contacted')}
                              >
                                تم التواصل
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy === `${cart._id}:dismiss`}
                                onClick={() => act(cart, 'dismiss')}
                              >
                                تجاهل
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => update({ page: String(p) })} />
      </Card>
    </>
  );
}
