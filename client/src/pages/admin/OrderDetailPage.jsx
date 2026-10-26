import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ConfirmDialog, DefinitionList, Field, Modal, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import {
  DeliveryStatusBadge,
  DemoBadge,
  OrderSyncBadge,
  ReviewStatusBadge,
  ReviewSyncBadge,
  SourceStatusBadge,
  SyncOperationBadge,
} from '../../components/StatusBadges.jsx';
import { Timeline } from '../../components/Timeline.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { FAILURE_REASON_LABELS, PAYMENT_STATUS_LABELS, SOURCE_STATUS_LABELS, label } from '../../utils/labels.js';
import { formatDateTime, formatMoney } from '../../utils/format.js';

const ASSIGNABLE = ['new', 'assigned', 'out_for_delivery', 'failed'];
const CANCELLABLE = ['new', 'assigned', 'out_for_delivery', 'failed'];

export function OrderDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const detail = useAsync(() => api.get(`/admin/orders/${id}`), [id]);
  const events = useAsync(() => api.get(`/admin/orders/${id}/events`), [id]);
  const couriers = useAsync(() => api.get('/admin/couriers-brief'), []);

  const [courierId, setCourierId] = useState('');
  const [confirmAssign, setConfirmAssign] = useState(null); // { courierId, label }
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [syncCancel, setSyncCancel] = useState(false);
  const [formError, setFormError] = useState('');

  const refresh = () => {
    detail.reload({ silent: true });
    events.reload({ silent: true });
  };

  const [assign, assigning] = useAction(async (target) => {
    try {
      await api.patch(`/admin/orders/${id}/assignment`, { courierId: target });
      toast.success(target ? 'تم تعيين المندوب' : 'تم إلغاء التعيين');
      setConfirmAssign(null);
      setCourierId('');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });

  const [changeStatus, changing] = useAction(async (body) => {
    setFormError('');
    try {
      const res = await api.patch(`/admin/orders/${id}/status`, body);
      toast.success(body.status === 'cancelled' ? 'تم إلغاء الطلب' : 'تمت إعادة فتح الطلب');
      if (res.syncOperation && res.syncOperation.state !== 'succeeded') {
        toast.info('لم تكتمل مزامنة الإلغاء مع EasyOrders بعد. تابعها من صفحة المزامنة.');
      }
      setCancelOpen(false);
      setReopenOpen(false);
      setReason('');
      refresh();
    } catch (err) {
      setFormError(err.details?.[0]?.message || err.message);
    }
  });

  const [retry, retrying] = useAction(async (opId) => {
    try {
      const res = await api.post(`/admin/sync/${opId}/retry`);
      if (res.operation?.state === 'succeeded') toast.success('تمت المزامنة مع EasyOrders');
      else toast.info('تمت إعادة المحاولة ولم تنجح بعد');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });

  const [ackConflict] = useAction(async () => {
    try {
      await api.post(`/admin/orders/${id}/conflict/acknowledge`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });

  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  const { order, reviews, syncOperations } = detail.data;
  const c = order.customer || {};

  return (
    <>
      <PageHeader
        back="/admin/orders"
        title={
          <>
            طلب <span className="mono">{order.easyOrdersId}</span> <DemoBadge show={order.isDemo} />
          </>
        }
        subtitle={`تاريخ الطلب: ${formatDateTime(order.sourceCreatedAt || order.createdAt)}`}
      />

      <div className="badge-row" aria-label="حالات الطلب">
        <SourceStatusBadge status={order.sourceStatus} />
        <DeliveryStatusBadge status={order.deliveryStatus} />
        <OrderSyncBadge state={order.sync?.state} />
      </div>

      {order.sourceConflict?.active && (
        <div className="alert alert--warning" role="alert">
          <div>
            <strong>تعارض مع EasyOrders:</strong> {order.sourceConflict.message}
          </div>
          <Button size="sm" variant="secondary" onClick={ackConflict}>
            تم الاطلاع
          </Button>
        </div>
      )}
      {order.sourceStatusNeedsVerification && (
        <div className="alert alert--info">وصلت حالة EasyOrders بترتيب غير متوقع ولم يتم التحقق منها بعد عبر API.</div>
      )}
      {order.sync?.state === 'failed' && order.sync.lastError && (
        <div className="alert alert--danger">آخر خطأ مزامنة: {order.sync.lastError}</div>
      )}

      <div className="grid-2">
        <Card title="بيانات العميل">
          <DefinitionList
            items={[
              ['الاسم', c.name],
              ['الهاتف', c.phone ? <a className="link mono" dir="ltr" href={`tel:${c.phone}`}>{c.phone}</a> : null],
              c.alternativePhone && ['هاتف بديل', <span className="mono" dir="ltr">{c.alternativePhone}</span>],
              ['المحافظة', c.government],
              c.area && ['المنطقة', c.area],
              ['العنوان', c.address],
              c.email && ['البريد', c.email],
              c.notes && ['ملاحظات', c.notes],
            ]}
          />
        </Card>

        <Card title="الدفع">
          <DefinitionList
            items={[
              ['طريقة الدفع', order.paymentMethod],
              ['حالة الدفع', label(PAYMENT_STATUS_LABELS, order.paymentStatus)],
              ['المنتجات', formatMoney(order.subtotal)],
              ['الشحن', formatMoney(order.shippingFee)],
              ['الخصم', formatMoney(order.discount)],
              ['الإجمالي', <strong>{formatMoney(order.totalAmount)}</strong>],
              order.cod?.isCod && ['النقدية المتوقعة', formatMoney(order.cod.expectedAmount)],
              order.cod?.declaredAmount !== null && order.cod?.declaredAmount !== undefined && ['المبلغ المعلن من المندوب', formatMoney(order.cod.declaredAmount)],
              order.cod?.isCod && ['التسوية النقدية', order.cod.remittance ? 'مضاف لتسوية' : 'لم تتم التسوية'],
            ]}
          />
        </Card>
      </div>

      <Card title="المنتجات">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>المنتج</th>
                <th>الخيارات</th>
                <th>SKU</th>
                <th>الكمية</th>
                <th>سعر الوحدة</th>
                <th>الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, i) => (
                <tr key={item.externalId || i}>
                  <td>{item.name}</td>
                  <td>{item.options?.map((o) => `${o.name}: ${o.value}`).join('، ') || '—'}</td>
                  <td className="mono">{item.sku || '—'}</td>
                  <td>{item.quantity}</td>
                  <td className="nowrap">{formatMoney(item.price)}</td>
                  <td className="nowrap">{formatMoney(item.price * item.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="المندوب والتعيين">
          <DefinitionList
            items={[
              ['المندوب الحالي', order.assignedTo ? `${order.assignedTo.name} (${order.assignedTo.phone})` : 'غير معيّن'],
              ['عيّنه', order.assignedBy?.name],
              ['وقت التعيين', formatDateTime(order.assignedAt)],
            ]}
          />
          {ASSIGNABLE.includes(order.deliveryStatus) ? (
            <div className="inline-form">
              <select className="input" aria-label="اختر مندوب" value={courierId} onChange={(e) => setCourierId(e.target.value)}>
                <option value="">اختر مندوب...</option>
                {couriers.data?.items
                  .filter((x) => x.isActive && x.id !== order.assignedTo?._id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
              </select>
              <Button
                disabled={!courierId}
                onClick={() =>
                  setConfirmAssign({ courierId, label: couriers.data.items.find((x) => x.id === courierId)?.name })
                }
              >
                {order.assignedTo ? 'إعادة التعيين' : 'تعيين'}
              </Button>
              {order.assignedTo && (
                <Button variant="secondary" onClick={() => setConfirmAssign({ courierId: null, label: null })}>
                  إلغاء التعيين
                </Button>
              )}
            </div>
          ) : (
            <p className="muted">لا يمكن تغيير المندوب في حالة الطلب الحالية.</p>
          )}
          <p className="muted small">التعيين لا يغيّر حالة الطلب في EasyOrders.</p>
        </Card>

        <Card title="إجراءات الطلب">
          <div className="action-list">
            {CANCELLABLE.includes(order.deliveryStatus) && (
              <Button variant="danger" onClick={() => { setFormError(''); setCancelOpen(true); }}>
                إلغاء الطلب
              </Button>
            )}
            {['failed', 'cancelled'].includes(order.deliveryStatus) && (
              <Button variant="secondary" onClick={() => { setFormError(''); setReopenOpen(true); }}>
                إعادة فتح الطلب
              </Button>
            )}
            {order.deliveryStatus === 'pending_delivery_review' && order.currentReview && (
              <Link className="btn btn--primary" to={`/admin/reviews/${order.currentReview}`}>
                مراجعة تأكيد التسليم
              </Link>
            )}
          </div>
          {order.cancellation?.reason && (
            <p className="muted">
              سبب الإلغاء: {order.cancellation.reason} ({order.cancellation.source === 'easyorders' ? 'من EasyOrders' : order.cancellation.by?.name || 'مشرف'})
            </p>
          )}
        </Card>
      </div>

      <Card title="محاولات التوصيل الفاشلة">
        {!order.deliveryAttempts?.length ? (
          <EmptyState title="لا توجد محاولات فاشلة" />
        ) : (
          <ul className="simple-list">
            {order.deliveryAttempts.map((a) => (
              <li key={a._id}>
                <strong>{label(FAILURE_REASON_LABELS, a.reason)}</strong>
                {a.note && <span> — {a.note}</span>}
                <div className="muted small">{a.courier?.name} · {formatDateTime(a.at)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="سجل مراجعات التسليم">
        {!reviews.length ? (
          <EmptyState title="لم يرسل المندوب تأكيد تسليم بعد" />
        ) : (
          <ul className="simple-list">
            {reviews.map((r) => (
              <li key={r._id}>
                <div className="badge-row">
                  <ReviewStatusBadge status={r.status} />
                  {r.status === 'approved' && <ReviewSyncBadge status={r.syncStatus} />}
                  <Link className="link" to={`/admin/reviews/${r._id}`}>عرض التفاصيل</Link>
                </div>
                <div className="muted small">
                  محاولة #{r.submissionNumber} · {r.courier?.name} · أُرسل {formatDateTime(r.submittedAt)}
                  {r.reviewer && ` · راجعه ${r.reviewer.name} ${formatDateTime(r.reviewedAt)}`}
                </div>
                {r.rejectionReason && <p>سبب الرفض: {r.rejectionReason}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="المزامنة مع EasyOrders">
        {!syncOperations.length ? (
          <EmptyState title="لا توجد عمليات مزامنة لهذا الطلب" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الحالة المطلوبة</th>
                  <th>النتيجة</th>
                  <th>المحاولات</th>
                  <th>آخر خطأ</th>
                  <th>آخر تحديث</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {syncOperations.map((op) => (
                  <tr key={op._id}>
                    <td>{label(SOURCE_STATUS_LABELS, op.targetStatus)}</td>
                    <td><SyncOperationBadge state={op.state} /></td>
                    <td>{op.attempts}</td>
                    <td className="small">{op.lastError || '—'}</td>
                    <td className="nowrap muted">{formatDateTime(op.updatedAt)}</td>
                    <td>
                      {op.state !== 'succeeded' && op.state !== 'in_progress' && (
                        <Button size="sm" variant="secondary" loading={retrying} onClick={() => retry(op._id)}>
                          إعادة المحاولة
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="سجل الأحداث">
        {events.loading && !events.data ? <LoadingState /> : events.error ? <ErrorState error={events.error} onRetry={events.reload} /> : <Timeline events={events.data.items} />}
      </Card>

      <ConfirmDialog
        open={Boolean(confirmAssign)}
        title={confirmAssign?.courierId ? 'تأكيد تعيين المندوب' : 'تأكيد إلغاء التعيين'}
        message={
          confirmAssign?.courierId
            ? `سيتم تعيين الطلب للمندوب "${confirmAssign?.label}".`
            : 'سيتم سحب الطلب من المندوب الحالي وإرجاعه لقائمة الطلبات الجديدة.'
        }
        loading={assigning}
        onClose={() => setConfirmAssign(null)}
        onConfirm={() => assign(confirmAssign.courierId)}
      />

      <Modal
        open={cancelOpen}
        title="إلغاء الطلب"
        onClose={() => setCancelOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={changing}>تراجع</Button>
            <Button variant="danger" loading={changing} onClick={() => changeStatus({ status: 'cancelled', reason, syncToEasyOrders: syncCancel })}>
              تأكيد الإلغاء
            </Button>
          </>
        }
      >
        <Field label="سبب الإلغاء" required error={formError}>
          {(fid) => <textarea id={fid} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={syncCancel} onChange={(e) => setSyncCancel(e.target.checked)} />
          <span>تحديث حالة الطلب في EasyOrders إلى "ملغي" أيضاً</span>
        </label>
      </Modal>

      <Modal
        open={reopenOpen}
        title="إعادة فتح الطلب"
        onClose={() => setReopenOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReopenOpen(false)} disabled={changing}>تراجع</Button>
            <Button loading={changing} onClick={() => changeStatus({ status: 'new', reason })}>إعادة الفتح</Button>
          </>
        }
      >
        <p>سيعود الطلب لحالة "جديد" بدون مندوب، ولن يتم تغيير حالته في EasyOrders.</p>
        <Field label="السبب" required error={formError}>
          {(fid) => <textarea id={fid} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Modal>
    </>
  );
}
