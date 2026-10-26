import { useState } from 'react';
import { Button, Field, Modal } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { RemittanceStatusBadge } from '../../components/StatusBadges.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, formatMoney, isValidMoneyInput, minorToInput, toAsciiDigits } from '../../utils/format.js';

export function CourierCashPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get('/courier/cash'), []);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState('');

  const [declare, declaring] = useAction(async () => {
    setFormError('');
    if (!isValidMoneyInput(amount)) return setFormError('أدخل المبلغ الذي ستسلمه');
    try {
      await api.post('/courier/cash/remittances', {
        orderIds: data.eligibleOrders.map((o) => o._id),
        declaredAmount: amount,
      });
      toast.success('تم تسجيل تسليم النقدية. بانتظار تأكيد الإدارة.');
      setOpen(false);
      reload({ silent: true });
    } catch (err) {
      setFormError(err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { summary, eligibleOrders, remittances } = data;

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">النقدية التي معك</h2>
        <p className="panel__amount">{formatMoney(summary.unremittedExpected)}</p>
        <p className="muted">من {summary.unremittedCount} طلب تمت الموافقة على تسليمه ولم يتم تسليم نقديتها للإدارة.</p>
        {summary.inTransitCount > 0 && (
          <p className="muted small">بالإضافة إلى {formatMoney(summary.inTransitExpected)} لطلبات قيد التوصيل أو المراجعة.</p>
        )}
        {eligibleOrders.length > 0 && (
          <Button size="lg" className="btn--block" onClick={() => { setAmount(minorToInput(summary.unremittedExpected)); setFormError(''); setOpen(true); }}>
            تسليم النقدية للإدارة
          </Button>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">بانتظار تأكيد الإدارة</h2>
        <p className="panel__big">{formatMoney(summary.awaitingVerification)}</p>
      </section>

      <section className="panel">
        <h2 className="panel__title">سجل التسليمات</h2>
        {!remittances.length ? (
          <EmptyState title="لا توجد تسليمات نقدية بعد" />
        ) : (
          <ul className="simple-list">
            {remittances.map((r) => (
              <li key={r._id}>
                <div className="row-between">
                  <strong>{formatMoney(r.declaredAmount ?? r.handedOverAmount)}</strong>
                  <RemittanceStatusBadge status={r.status} />
                </div>
                <div className="muted small">{r.orders.length} طلب · {formatDateTime(r.createdAt)}</div>
                {r.difference ? <div className="text-danger small">فرق: {formatMoney(r.difference)}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={open}
        title="تسليم النقدية للإدارة"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={declaring}>إلغاء</Button>
            <Button loading={declaring} onClick={declare}>تأكيد</Button>
          </>
        }
      >
        <p>الطلبات المشمولة ({eligibleOrders.length}):</p>
        <ul className="simple-list small">
          {eligibleOrders.map((o) => (
            <li key={o._id}><span className="mono">#{o.easyOrdersId}</span> — {formatMoney(o.cod.expectedAmount)}</li>
          ))}
        </ul>
        <Field label="المبلغ الذي ستسلمه (ج.م)" required hint={`المتوقع: ${formatMoney(summary.unremittedExpected)}`}>
          {(id) => (
            <input id={id} className="input input--lg" dir="ltr" inputMode="decimal" value={amount}
              onChange={(e) => setAmount(toAsciiDigits(e.target.value).replace(/[^\d.]/g, ''))} />
          )}
        </Field>
        <p className="muted small">ستقوم الإدارة بعدّ المبلغ وتأكيده.</p>
        {formError && <p className="form-error" role="alert">{formError}</p>}
      </Modal>
    </>
  );
}
