import { useState } from 'react';
import { Button, Field, Modal } from './ui.jsx';
import { useToast } from './Toast.jsx';
import { useAction } from '../hooks/useAsync.js';
import { api } from '../services/api.js';
import { FAILURE_REASON_LABELS, RETURN_SYNC_OPTIONS, label } from '../utils/labels.js';
import { orderNumber } from '../utils/format.js';

/**
 * Admin confirms a failed / refused delivery as a return. Like an approved
 * delivery, the outcome is then pushed to EasyOrders (unless "none" is chosen).
 */
export function ConfirmReturnModal({ order, lastAttempt, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('returning_from_delivery');
  const [error, setError] = useState('');

  const [submit, submitting] = useAction(async () => {
    setError('');
    try {
      const res = await api.post(`/admin/orders/${order._id}/return`, {
        reason: reason.trim() || undefined,
        easyOrdersStatus: status,
      });
      const syncState = res.syncOperation?.state;
      if (status === 'none') toast.success('تم اعتماد الطلب كمرتجع');
      else if (syncState === 'succeeded') toast.success('تم اعتماد المرتجع وتحديث EasyOrders');
      else toast.success('تم اعتماد المرتجع. سيتم تحديث EasyOrders تلقائياً (تابع صفحة المزامنة)');
      onDone?.(res);
    } catch (err) {
      setError(err.message);
    }
  });

  if (!order) return null;
  return (
    <Modal
      open
      title={`تأكيد مرتجع الطلب ${orderNumber(order)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            تراجع
          </Button>
          <Button variant="danger" loading={submitting} onClick={submit}>
            تأكيد المرتجع
          </Button>
        </>
      }
    >
      {lastAttempt && (
        <p>
          <strong>سبب المندوب:</strong> {label(FAILURE_REASON_LABELS, lastAttempt.reason)}
          {lastAttempt.note ? ` — ${lastAttempt.note}` : ''}
        </p>
      )}
      <Field label="ملاحظة المشرف (اختياري)">
        {(id) => <textarea id={id} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <Field label="الحالة التي ستُرسل إلى EasyOrders" error={error}>
        {(id) => (
          <select id={id} className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {RETURN_SYNC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="muted small">لو تريد إعادة محاولة التوصيل بدلاً من المرتجع، افتح الطلب وعيّنه لمندوب مرة أخرى.</p>
    </Modal>
  );
}
