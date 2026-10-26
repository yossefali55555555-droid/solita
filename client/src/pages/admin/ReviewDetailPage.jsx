import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ConfirmDialog, DefinitionList, Field, Modal, PageHeader } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import {
  DeliveryStatusBadge,
  DemoBadge,
  ReviewStatusBadge,
  ReviewSyncBadge,
  SourceStatusBadge,
  SyncOperationBadge,
} from '../../components/StatusBadges.jsx';
import { Timeline } from '../../components/Timeline.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { label, SOURCE_STATUS_LABELS, SYNC_OP_LABELS } from '../../utils/labels.js';
import { formatDateTime, formatMoney } from '../../utils/format.js';

export function ReviewDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get(`/admin/delivery-reviews/${id}`), [id]);
  const orderId = data?.order?._id;
  const events = useAsync(() => (orderId ? api.get(`/admin/orders/${orderId}/events`) : Promise.resolve(null)), [orderId]);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');

  const refresh = () => {
    reload({ silent: true });
    events.reload({ silent: true });
  };

  const [approve, approving] = useAction(async () => {
    try {
      const res = await api.post(`/admin/delivery-reviews/${id}/approve`);
      setApproveOpen(false);
      const state = res.syncOperation?.state;
      if (res.review.syncStatus === 'synced') toast.success('تمت الموافقة وتم تحديث EasyOrders إلى "تم التسليم"');
      else toast.info(`تمت الموافقة. لم تكتمل مزامنة EasyOrders بعد (${state ? label(SYNC_OP_LABELS, state) : 'قيد الانتظار'}).`);
      refresh();
    } catch (err) {
      setApproveOpen(false);
      toast.error(err.message);
      refresh();
    }
  });

  const [reject, rejecting] = useAction(async () => {
    if (reason.trim().length < 3) {
      setReasonError('سبب الرفض مطلوب (3 أحرف على الأقل)');
      return;
    }
    try {
      await api.post(`/admin/delivery-reviews/${id}/reject`, { reason: reason.trim() });
      setRejectOpen(false);
      setReason('');
      toast.success('تم رفض تأكيد التسليم وإبلاغ المندوب');
      refresh();
    } catch (err) {
      setReasonError(err.details?.[0]?.message || err.message);
    }
  });

  const [retry, retrying] = useAction(async () => {
    try {
      const res = await api.post(`/admin/sync/${data.review.syncOperation._id}/retry`);
      if (res.operation.state === 'succeeded') toast.success('تمت المزامنة مع EasyOrders');
      else toast.info('تمت إعادة المحاولة ولم تنجح بعد');
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { review, order, history } = data;
  const c = order?.customer || {};
  const op = review.syncOperation;
  const amountMismatch =
    review.expectedAmount > 0 && review.collectedAmount !== null && review.collectedAmount !== review.expectedAmount;

  return (
    <>
      <PageHeader
        back="/admin/reviews"
        title={<>مراجعة تسليم الطلب <span className="mono">{order?.easyOrdersId}</span> <DemoBadge show={order?.isDemo} /></>}
        subtitle={`أرسله ${review.courier?.name} في ${formatDateTime(review.submittedAt)}`}
        actions={<Link className="btn btn--secondary" to={`/admin/orders/${order?._id}`}>صفحة الطلب</Link>}
      />

      <div className="badge-row">
        <ReviewStatusBadge status={review.status} />
        <SourceStatusBadge status={order?.sourceStatus} />
        <DeliveryStatusBadge status={order?.deliveryStatus} />
        {review.status === 'approved' && <ReviewSyncBadge status={review.syncStatus} />}
      </div>

      {order?.sourceConflict?.active && (
        <div className="alert alert--warning">تعارض مع EasyOrders: {order.sourceConflict.message}</div>
      )}

      {review.status === 'pending' && (
        <Card className="decision">
          <p>تأكد من استلام العميل للطلب قبل الموافقة. عند الموافقة سيتم تحديث الطلب في EasyOrders إلى "تم التسليم".</p>
          <div className="action-list">
            <Button onClick={() => setApproveOpen(true)}>موافقة على التسليم</Button>
            <Button variant="danger" onClick={() => { setReasonError(''); setRejectOpen(true); }}>رفض</Button>
          </div>
        </Card>
      )}

      {review.status === 'approved' && review.syncStatus !== 'synced' && (
        <div className="alert alert--danger">
          <div>
            تمت الموافقة داخلياً، لكن <strong>لم يتم تأكيد التحديث في EasyOrders بعد</strong>.
            {review.lastSyncError && <div className="small">آخر خطأ: {review.lastSyncError}</div>}
          </div>
          {op && op.state !== 'succeeded' && op.state !== 'in_progress' && (
            <Button size="sm" variant="secondary" loading={retrying} onClick={retry}>إعادة محاولة المزامنة</Button>
          )}
        </div>
      )}

      <div className="grid-2">
        <Card title="العميل والعنوان">
          <DefinitionList
            items={[
              ['الاسم', c.name],
              ['الهاتف', <span className="mono" dir="ltr">{c.phone}</span>],
              ['المحافظة', c.government],
              ['العنوان', c.address],
            ]}
          />
        </Card>
        <Card title="تفاصيل التقرير">
          <DefinitionList
            items={[
              ['المندوب', `${review.courier?.name} (${review.courier?.phone})`],
              ['إجمالي الطلب', formatMoney(order?.totalAmount)],
              ['طريقة الدفع', order?.paymentMethod],
              review.expectedAmount > 0 && ['النقدية المتوقعة', formatMoney(review.expectedAmount)],
              review.collectedAmount !== null && [
                'المبلغ المحصّل (حسب المندوب)',
                <span className={amountMismatch ? 'text-danger' : ''}>{formatMoney(review.collectedAmount)}</span>,
              ],
              ['ملاحظة المندوب', review.courierNote],
              ['مرجع إثبات التسليم', review.proofReference || 'لا يوجد'],
              ['حالة EasyOrders عند الإرسال', label(SOURCE_STATUS_LABELS, review.sourceStatusAtSubmission)],
              review.reviewer && ['المراجع', `${review.reviewer.name} — ${formatDateTime(review.reviewedAt)}`],
              review.rejectionReason && ['سبب الرفض', review.rejectionReason],
              op && ['عملية المزامنة', <SyncOperationBadge state={op.state} />],
            ]}
          />
          {amountMismatch && <p className="text-danger small">المبلغ المحصّل يختلف عن المتوقع.</p>}
        </Card>
      </div>

      <Card title="سجل المراجعات لهذا الطلب">
        <ul className="simple-list">
          {history.map((h) => (
            <li key={h._id}>
              <div className="badge-row">
                <ReviewStatusBadge status={h.status} />
                <span className="muted small">#{h.submissionNumber} · {h.courier?.name} · {formatDateTime(h.submittedAt)}</span>
              </div>
              {h.rejectionReason && <p className="small">سبب الرفض: {h.rejectionReason}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="سجل أحداث الطلب">
        {events.data ? <Timeline events={events.data.items} /> : <LoadingState />}
      </Card>

      <ConfirmDialog
        open={approveOpen}
        title="تأكيد الموافقة على التسليم"
        message="سيتم اعتماد الطلب كمُسلَّم وإرسال الحالة 'تم التسليم' إلى EasyOrders. هذا الإجراء لا يمكن التراجع عنه من النظام."
        confirmLabel="موافقة"
        loading={approving}
        onClose={() => setApproveOpen(false)}
        onConfirm={approve}
      />

      <Modal
        open={rejectOpen}
        title="رفض تأكيد التسليم"
        onClose={() => setRejectOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejectOpen(false)} disabled={rejecting}>تراجع</Button>
            <Button variant="danger" loading={rejecting} onClick={reject}>تأكيد الرفض</Button>
          </>
        }
      >
        <p>سيعود الطلب للمندوب للمتابعة، ولن يتم تغيير حالته في EasyOrders.</p>
        <Field label="سبب الرفض" required error={reasonError}>
          {(fid) => <textarea id={fid} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Modal>
    </>
  );
}
