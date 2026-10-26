import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, ConfirmDialog, Field, Modal } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, DemoBadge, ReviewStatusBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { FAILURE_REASON_LABELS, PAYMENT_STATUS_LABELS, label } from '../../utils/labels.js';
import { formatDateTime, formatMoney, isValidMoneyInput, minorToInput, toAsciiDigits } from '../../utils/format.js';

export function CourierOrderPage() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get(`/courier/orders/${id}`), [id]);
  const [startOpen, setStartOpen] = useState(false);
  const [failOpen, setFailOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [fail, setFail] = useState({ reason: '', note: '' });
  const [deliver, setDeliver] = useState({ collectedAmount: '', note: '', proofReference: '' });
  const [formError, setFormError] = useState('');
  const [submittedMessage, setSubmittedMessage] = useState('');

  const [start, starting] = useAction(async () => {
    try {
      await api.patch(`/courier/orders/${id}/status`, { status: 'out_for_delivery' });
      toast.success('تم بدء التوصيل');
      setStartOpen(false);
      reload({ silent: true });
    } catch (err) {
      setStartOpen(false);
      toast.error(err.message);
    }
  });

  const [reportFail, failing] = useAction(async () => {
    setFormError('');
    if (!fail.reason) return setFormError('اختر سبب فشل التسليم');
    if (fail.reason === 'other' && fail.note.trim().length < 3) return setFormError('اكتب توضيحاً للسبب');
    try {
      await api.patch(`/courier/orders/${id}/status`, { status: 'failed', reason: fail.reason, note: fail.note.trim() || undefined });
      toast.success('تم تسجيل المحاولة الفاشلة');
      setFailOpen(false);
      setFail({ reason: '', note: '' });
      reload({ silent: true });
    } catch (err) {
      setFormError(err.details?.[0]?.message || err.message);
    }
  });

  const [submitDelivery, submitting] = useAction(async (expected) => {
    setFormError('');
    const amount = deliver.collectedAmount.trim();
    if (expected > 0 && !isValidMoneyInput(amount)) return setFormError('أدخل المبلغ الذي حصّلته من العميل');
    try {
      const res = await api.post(`/courier/orders/${id}/delivery-report`, {
        collectedAmount: amount || undefined,
        note: deliver.note.trim() || undefined,
        proofReference: deliver.proofReference.trim() || undefined,
      });
      setDeliverOpen(false);
      setSubmittedMessage(res.message);
      reload({ silent: true });
    } catch (err) {
      setFormError(err.details?.[0]?.message || err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { order, reviews, allowedActions } = data;
  const c = order.customer || {};
  const expected = order.cod?.isCod ? order.cod.expectedAmount || 0 : 0;
  const latestReview = reviews[0];
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.address || ''} ${c.government || ''}`)}`;

  return (
    <div className="courier-order">
      <Link to="/courier" className="page-header__back">→ طلباتي</Link>
      <div className="courier-order__head">
        <h1 className="mono">#{order.easyOrdersId}</h1>
        <DemoBadge show={order.isDemo} />
      </div>
      <div className="badge-stack">
        <DeliveryStatusBadge status={order.deliveryStatus} />
        <SourceStatusBadge status={order.sourceStatus} />
        {latestReview && <ReviewStatusBadge status={latestReview.status} />}
      </div>

      {submittedMessage && order.deliveryStatus === 'pending_delivery_review' && (
        <div className="alert alert--success" role="status">{submittedMessage}</div>
      )}
      {order.deliveryStatus === 'pending_delivery_review' && !submittedMessage && (
        <div className="alert alert--info">تم إرسال الطلب للمراجعة. بانتظار موافقة المشرف.</div>
      )}
      {order.deliveryStatus === 'delivered' && (
        <div className="alert alert--success">تمت موافقة المشرف على التسليم.</div>
      )}
      {order.deliveryStatus === 'cancelled' && (
        <div className="alert alert--danger">تم إلغاء هذا الطلب. لا تقم بتسليمه.{order.cancellation?.reason ? ` (${order.cancellation.reason})` : ''}</div>
      )}
      {latestReview?.status === 'rejected' && order.deliveryStatus === 'out_for_delivery' && (
        <div className="alert alert--warning">
          <strong>رفض المشرف تأكيد التسليم:</strong> {latestReview.rejectionReason}
          <div className="small">يمكنك إعادة إرسال تأكيد التسليم بعد التأكد، أو تسجيل محاولة فاشلة.</div>
        </div>
      )}

      <section className="panel">
        <h2 className="panel__title">العميل</h2>
        <p className="panel__big">{c.name}</p>
        <div className="panel__actions">
          {c.phone && <a className="btn btn--primary btn--lg" href={`tel:${c.phone}`}>اتصال <span className="mono" dir="ltr">{c.phone}</span></a>}
          {c.alternativePhone && <a className="btn btn--secondary" href={`tel:${c.alternativePhone}`}>رقم بديل</a>}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">العنوان</h2>
        <p>{c.government}{c.area ? ` — ${c.area}` : ''}</p>
        <p className="panel__big">{c.address}</p>
        {c.notes && <p className="muted">ملاحظات: {c.notes}</p>}
        <a className="btn btn--secondary" href={mapsUrl} target="_blank" rel="noopener noreferrer">فتح في الخريطة</a>
      </section>

      <section className="panel">
        <h2 className="panel__title">المبلغ</h2>
        <p className="panel__amount">{formatMoney(order.totalAmount)}</p>
        <p className="muted">
          طريقة الدفع: {order.paymentMethod || '—'} · {label(PAYMENT_STATUS_LABELS, order.paymentStatus)}
        </p>
        {expected > 0 ? <p><strong>المطلوب تحصيله: {formatMoney(expected)}</strong></p> : <p>لا يوجد تحصيل نقدي.</p>}
      </section>

      <section className="panel">
        <h2 className="panel__title">المنتجات</h2>
        <ul className="simple-list">
          {order.items.map((item, i) => (
            <li key={item.externalId || i}>
              {item.quantity} × {item.name}
              {item.options?.length ? <span className="muted"> ({item.options.map((o) => o.value).join('، ')})</span> : null}
            </li>
          ))}
        </ul>
      </section>

      {order.deliveryAttempts?.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">محاولات سابقة</h2>
          <ul className="simple-list">
            {order.deliveryAttempts.map((a) => (
              <li key={a._id}>{label(FAILURE_REASON_LABELS, a.reason)}{a.note ? ` — ${a.note}` : ''} <span className="muted small">{formatDateTime(a.at)}</span></li>
            ))}
          </ul>
        </section>
      )}

      {allowedActions.length > 0 && (
        <div className="sticky-actions">
          {allowedActions.includes('start_delivery') && (
            <Button size="lg" className="btn--block" onClick={() => setStartOpen(true)}>بدء التوصيل</Button>
          )}
          {allowedActions.includes('submit_delivery') && (
            <Button
              size="lg"
              variant="success"
              className="btn--block"
              onClick={() => {
                setFormError('');
                setDeliver({ collectedAmount: expected ? minorToInput(expected) : '', note: '', proofReference: '' });
                setDeliverOpen(true);
              }}
            >
              تم التسليم
            </Button>
          )}
          {allowedActions.includes('report_failed') && (
            <Button size="lg" variant="secondary" className="btn--block" onClick={() => { setFormError(''); setFailOpen(true); }}>
              تعذر التسليم
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={startOpen}
        title="بدء التوصيل"
        message="هل أنت في طريقك لتوصيل هذا الطلب الآن؟"
        confirmLabel="نعم، بدء التوصيل"
        loading={starting}
        onClose={() => setStartOpen(false)}
        onConfirm={start}
      />

      <Modal
        open={failOpen}
        title="تعذر التسليم"
        onClose={() => setFailOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setFailOpen(false)} disabled={failing}>إلغاء</Button>
            <Button variant="danger" loading={failing} onClick={reportFail}>تسجيل المحاولة</Button>
          </>
        }
      >
        <fieldset className="radio-list">
          <legend>سبب عدم التسليم</legend>
          {Object.entries(FAILURE_REASON_LABELS).map(([value, text]) => (
            <label key={value} className="radio">
              <input type="radio" name="reason" value={value} checked={fail.reason === value} onChange={() => setFail({ ...fail, reason: value })} />
              <span>{text}</span>
            </label>
          ))}
        </fieldset>
        <Field label={fail.reason === 'other' ? 'التوضيح (مطلوب)' : 'ملاحظة (اختياري)'}>
          {(fid) => <textarea id={fid} className="input" rows={2} value={fail.note} onChange={(e) => setFail({ ...fail, note: e.target.value })} />}
        </Field>
        {formError && <p className="form-error" role="alert">{formError}</p>}
      </Modal>

      <Modal
        open={deliverOpen}
        title="تأكيد التسليم"
        onClose={() => setDeliverOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeliverOpen(false)} disabled={submitting}>إلغاء</Button>
            <Button variant="success" loading={submitting} onClick={() => submitDelivery(expected)}>إرسال للمراجعة</Button>
          </>
        }
      >
        <p>سيتم إرسال التأكيد للمشرف للمراجعة. لن يُعتبر الطلب مُسلّماً إلا بعد موافقته.</p>
        {expected > 0 && (
          <Field label="المبلغ المحصّل من العميل (ج.م)" required hint={`المطلوب: ${formatMoney(expected)}`}>
            {(fid) => (
              <input
                id={fid}
                className="input input--lg"
                dir="ltr"
                inputMode="decimal"
                value={deliver.collectedAmount}
                onChange={(e) => setDeliver({ ...deliver, collectedAmount: toAsciiDigits(e.target.value).replace(/[^\d.]/g, '') })}
              />
            )}
          </Field>
        )}
        <Field label="مرجع إثبات التسليم (اختياري)" hint="مثلاً: رقم إيصال أو اسم المستلم">
          {(fid) => <input id={fid} className="input" value={deliver.proofReference} onChange={(e) => setDeliver({ ...deliver, proofReference: e.target.value })} />}
        </Field>
        <Field label="ملاحظة (اختياري)">
          {(fid) => <textarea id={fid} className="input" rows={2} value={deliver.note} onChange={(e) => setDeliver({ ...deliver, note: e.target.value })} />}
        </Field>
        {formError && <p className="form-error" role="alert">{formError}</p>}
      </Modal>
    </div>
  );
}
