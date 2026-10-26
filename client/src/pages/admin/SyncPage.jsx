import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { SyncOperationBadge } from '../../components/StatusBadges.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { SOURCE_STATUS_LABELS, label } from '../../utils/labels.js';
import { formatDateTime } from '../../utils/format.js';

const TRIGGER_LABELS = {
  delivery_approved: 'موافقة على التسليم',
  delivery_started: 'بدء التوصيل',
  order_cancelled: 'إلغاء الطلب',
};

export function SyncPage() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/sync/failures', { page, limit: 20 }), [page]);
  const [busyId, setBusyId] = useState(null);

  const [retry] = useAction(async (opId) => {
    setBusyId(opId);
    try {
      const res = await api.post(`/admin/sync/${opId}/retry`);
      if (res.operation?.state === 'succeeded') toast.success('تمت المزامنة بنجاح');
      else toast.info('تمت إعادة المحاولة ولم تنجح بعد');
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  });

  const [retryWebhook] = useAction(async (eventId) => {
    setBusyId(eventId);
    try {
      const res = await api.post(`/admin/sync/webhooks/${eventId}/retry`);
      if (res.event.status === 'processed') toast.success('تمت معالجة الحدث');
      else toast.info('لم تنجح المعالجة بعد');
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  });

  const [processDue, processing] = useAction(async () => {
    try {
      const res = await api.post('/admin/sync/process-due');
      toast.success(`تمت معالجة ${res.operations.processed} عملية و${res.webhooks.processed} حدث`);
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <>
      <PageHeader
        title="المزامنة مع EasyOrders"
        subtitle="العمليات التي لم يؤكدها EasyOrders بعد، وأحداث Webhook التي لم تتم معالجتها"
        actions={<Button variant="secondary" loading={processing} onClick={processDue}>معالجة العمليات المستحقة الآن</Button>}
      />

      <Card title="تحديثات الحالة المرسلة إلى EasyOrders" padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد أخطاء مزامنة" description="كل التحديثات المرسلة تم تأكيدها من EasyOrders." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الطلب</th>
                  <th>الحالة المطلوبة</th>
                  <th>السبب</th>
                  <th>النتيجة</th>
                  <th>المحاولات</th>
                  <th>آخر خطأ</th>
                  <th>المحاولة التالية</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((op) => (
                  <tr key={op._id}>
                    <td>
                      {op.order ? <Link className="link mono" to={`/admin/orders/${op.order._id}`}>{op.order.easyOrdersId}</Link> : op.easyOrdersId}
                    </td>
                    <td>{label(SOURCE_STATUS_LABELS, op.targetStatus)}</td>
                    <td>{TRIGGER_LABELS[op.trigger] || op.trigger}</td>
                    <td>
                      <SyncOperationBadge state={op.state} />
                      {op.permanentError && <Badge tone="danger">خطأ دائم</Badge>}
                    </td>
                    <td>{op.attempts}{op.rateLimitedCount ? ` (+${op.rateLimitedCount} حد الطلبات)` : ''}</td>
                    <td className="small">{op.lastError || '—'}</td>
                    <td className="nowrap muted">{op.state === 'failed' ? '—' : formatDateTime(op.nextAttemptAt)}</td>
                    <td>
                      <Button size="sm" variant="secondary" loading={busyId === op._id} onClick={() => retry(op._id)}>
                        إعادة المحاولة
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={setPage} />
      </Card>

      <Card title="أحداث Webhook الواردة غير المعالجة" padded={false}>
        {!data?.webhooks?.length ? (
          <EmptyState title="لا توجد أحداث معلقة" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>رقم الطلب في EasyOrders</th><th>النوع</th><th>الحالة</th><th>المحاولات</th><th>آخر خطأ</th><th>وقت الاستلام</th><th /></tr>
              </thead>
              <tbody>
                {data.webhooks.map((w) => (
                  <tr key={w._id}>
                    <td className="mono">{w.externalOrderId || '—'}</td>
                    <td>{w.eventType === 'order' ? 'طلب' : 'تغيير حالة'}</td>
                    <td><Badge tone={w.status === 'failed' ? 'danger' : 'warning'}>{w.status === 'failed' ? 'فشل' : 'إعادة محاولة مجدولة'}</Badge></td>
                    <td>{w.attempts}</td>
                    <td className="small">{w.lastError || '—'}</td>
                    <td className="nowrap muted">{formatDateTime(w.receivedAt)}</td>
                    <td>
                      <Button size="sm" variant="secondary" loading={busyId === w._id} onClick={() => retryWebhook(w._id)}>إعادة المعالجة</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
