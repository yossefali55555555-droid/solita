import { useState } from 'react';
import { Button, Field, Modal } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction } from '../../hooks/useAsync.js';
import { downloadFile } from '../../services/api.js';

const startOf = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const endOf = (d) => (d ? new Date(`${d}T23:59:59`).toISOString() : undefined);

/**
 * «تصدير لميتا»: the file is built on the server (needs the export + customer phone grants) in Meta's own
 * column names, ready for Ads Manager → Audiences → customer list (or Events Manager → offline events).
 */
export function MetaExportModal({ open, onClose }) {
  const toast = useToast();
  const [mode, setMode] = useState('customers');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minOrders, setMinOrders] = useState('1');
  const [includeReturned, setIncludeReturned] = useState(false);
  const [hash, setHash] = useState('none');

  const [run, running] = useAction(async () => {
    try {
      await downloadFile('/admin/customers/export-meta', {
        query: {
          mode,
          from: startOf(from),
          to: endOf(to),
          minOrders: mode === 'customers' ? Math.max(1, Number(minOrders) || 1) : undefined,
          includeReturned: mode === 'customers' && includeReturned ? 'true' : undefined,
          hash,
        },
        filename: mode === 'customers' ? 'meta-customers.csv' : 'meta-orders.csv',
      });
      toast.success('تم تجهيز الملف');
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <Modal
      open={open}
      title="تصدير لإعلانات ميتا"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>إلغاء</Button>
          <Button loading={running} onClick={run}>تنزيل الملف</Button>
        </>
      }
    >
      <Field label="نوع الملف">
        {(id) => (
          <select id={id} className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="customers">قائمة عملاء مع قيمة العميل (لإنشاء جمهور وجمهور مشابه بالقيمة)</option>
            <option value="orders">مشتريات: صف لكل طلب مُسلَّم (لأحداث الشراء خارج الموقع)</option>
          </select>
        )}
      </Field>
      <div className="filters">
        <Field label="من تاريخ">{(id) => <input id={id} className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="إلى تاريخ">{(id) => <input id={id} className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      {mode === 'customers' && (
        <>
          <Field label="أقل عدد طلبات مُسلَّمة للعميل" hint="ارفعه (مثلًا 2) لتصدير العملاء المتكررين فقط.">
            {(id) => <input id={id} className="input" type="number" min="1" max="100" inputMode="numeric" value={minOrders} onChange={(e) => setMinOrders(e.target.value)} />}
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={includeReturned} onChange={(e) => setIncludeReturned(e.target.checked)} />
            <span>إضافة العملاء أصحاب المرتجعات (قيمتهم تُحسب من الطلبات المُسلَّمة فقط)</span>
          </label>
        </>
      )}
      <Field
        label="تجزئة البيانات"
        hint={hash === 'none' ? 'مدير إعلانات ميتا يجزّئ البيانات داخل المتصفح قبل الرفع، فهذا هو الخيار المعتاد.' : 'SHA-256 للأدوات التي ترسل الملف كما هو (واجهة ميتا البرمجية).'}
      >
        {(id) => (
          <select id={id} className="input" value={hash} onChange={(e) => setHash(e.target.value)}>
            <option value="none">بدون تجزئة (للرفع من مدير الإعلانات)</option>
            <option value="sha256">SHA-256</option>
          </select>
        )}
      </Field>
      <p className="muted small">
        الملف يحتوي أرقام العملاء وإيميلاتهم وأسماءهم، وتصديره يُسجَّل في سجل النشاط. الطلبات التجريبية مستبعدة دائمًا.
        ميتا تطلب 1000 عميل على الأقل في القائمة، وتحتاج رقم الهاتف بصيغة دولية (يُجهَّز تلقائيًا).
      </p>
    </Modal>
  );
}
