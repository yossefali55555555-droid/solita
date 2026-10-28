import { useState } from 'react';
import { Button, Field, Modal } from './ui.jsx';
import { useToast } from './Toast.jsx';
import { useAction, useAsync } from '../hooks/useAsync.js';
import { api } from '../services/api.js';
import { formatDateTime, toAsciiDigits } from '../utils/format.js';

function pollMessage(result) {
  switch (result?.status) {
    case 'ok':
      return result.created
        ? `تم استيراد ${result.created} طلب جديد${result.refreshed ? ` وتحديث ${result.refreshed}` : ''}`
        : `لا توجد طلبات جديدة${result.refreshed ? ` (تم تحديث ${result.refreshed} طلب)` : ''}`;
    case 'needs_start':
      return 'استورد آخر طلب برقمه مرة واحدة، وبعدها تبدأ المزامنة التلقائية من بعده';
    case 'not_configured':
      return 'أضف EASYORDERS_API_KEY أولاً';
    case 'already_running':
      return 'المزامنة تعمل الآن بالفعل، حاول بعد دقيقة';
    case 'rate_limited':
      return `تم تجاوز حد طلبات EasyOrders مؤقتاً. تم استيراد ${result.created || 0} حتى الآن`;
    default:
      return result?.errors?.[0]?.message ? `توقفت المزامنة: ${result.errors[0].message}` : 'توقفت المزامنة';
  }
}

/** "Sync now" + "Import by order number" for the admin orders page. */
export function EasyOrdersSync({ onChange }) {
  const toast = useToast();
  const status = useAsync(() => api.get('/admin/easyorders/poll'), []);
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');

  const [syncNow, syncing] = useAction(async () => {
    try {
      const res = await api.post('/admin/easyorders/poll');
      const ok = res.result?.status === 'ok';
      (ok ? toast.success : toast.info)(pollMessage(res.result));
      status.reload({ silent: true });
      if (res.result?.created || res.result?.refreshed) onChange?.();
    } catch (err) {
      toast.error(err.message);
    }
  });

  const [importOne, importing] = useAction(async () => {
    const value = toAsciiDigits(number.trim()).replace(/^#/, '');
    if (!/^\d+$/.test(value)) {
      setError('اكتب رقم الطلب كما يظهر في EasyOrders (أرقام فقط)');
      return;
    }
    try {
      const res = await api.post('/admin/easyorders/import', { shortId: Number(value) });
      toast.success(res.outcome === 'created' ? `تم استيراد الطلب #${value}` : `الطلب #${value} موجود وتم تحديثه`);
      setOpen(false);
      setNumber('');
      status.reload({ silent: true });
      onChange?.();
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    }
  });

  const s = status.data;
  return (
    <>
      <div className="action-list">
        <Button variant="secondary" loading={syncing} onClick={syncNow}>مزامنة مع EasyOrders الآن</Button>
        <Button variant="secondary" onClick={() => { setError(''); setOpen(true); }}>استيراد طلب برقمه</Button>
      </div>
      {s && (
        <p className="muted small">
          {s.lastRunAt ? `آخر مزامنة: ${formatDateTime(s.lastRunAt)}` : 'لم تتم مزامنة تلقائية بعد'}
          {s.lastShortId ? ` · آخر رقم طلب معروف: #${s.lastShortId}` : ''}
        </p>
      )}
      <Modal
        open={open}
        title="استيراد طلب من EasyOrders"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={importing}>إلغاء</Button>
            <Button loading={importing} onClick={importOne}>استيراد</Button>
          </>
        }
      >
        <p>اكتب رقم الطلب كما يظهر في لوحة EasyOrders (مثلاً 43). لو الطلب موجود بالفعل يتم تحديثه فقط.</p>
        <Field label="رقم الطلب" required error={error}>
          {(fid) => (
            <input
              id={fid}
              className="input"
              inputMode="numeric"
              dir="ltr"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && importOne()}
            />
          )}
        </Field>
      </Modal>
    </>
  );
}
