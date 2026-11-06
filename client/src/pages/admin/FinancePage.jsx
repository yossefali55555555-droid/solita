import { useState } from 'react';
import { Button, Card, ConfirmDialog, Field, Modal, PageHeader, Pagination, StatCard } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { EXPENSE_CATEGORY_LABELS, label } from '../../utils/labels.js';
import { formatDate, formatMoney, formatNumber, isValidMoneyInput, minorToInput, toAsciiDigits } from '../../utils/format.js';

const pad = (n) => String(n).padStart(2, '0');
const dayString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: dayString(start), to: dayString(end) };
}

const PRESETS = [
  { label: 'هذا الشهر', range: () => monthRange(0) },
  { label: 'الشهر الماضي', range: () => monthRange(-1) },
  { label: 'اليوم', range: () => ({ from: dayString(new Date()), to: dayString(new Date()) }) },
  { label: 'كل الفترات', range: () => ({ from: '', to: '' }) },
];

/** Local calendar days → ISO timestamps covering the whole days. */
function toQuery({ from, to }) {
  return {
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  };
}

function MoneyInput({ id, value, onChange }) {
  return (
    <input
      id={id}
      className="input"
      dir="ltr"
      inputMode="decimal"
      placeholder="0.00"
      value={value}
      onChange={(e) => onChange(toAsciiDigits(e.target.value).replace(/[^\d.]/g, ''))}
    />
  );
}

const EMPTY_FORM = () => ({ date: dayString(new Date()), amount: '', category: '', description: '', invoiceNumber: '', vendor: '' });

function ExpenseModal({ expense, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(expense?._id);
  const [form, setForm] = useState(() =>
    editing
      ? {
          date: dayString(new Date(expense.date)),
          amount: minorToInput(expense.amount),
          category: expense.category,
          description: expense.description || '',
          invoiceNumber: expense.invoiceNumber || '',
          vendor: expense.vendor || '',
        }
      : EMPTY_FORM(),
  );
  const [error, setError] = useState('');
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const [save, saving] = useAction(async () => {
    setError('');
    if (!form.date) return setError('اختر تاريخ الفاتورة');
    if (!isValidMoneyInput(form.amount) || Number(form.amount) <= 0) return setError('أدخل مبلغاً صحيحاً أكبر من صفر');
    if (!form.category) return setError('اختر نوع المصروف');
    if (form.category === 'other' && form.description.trim().length < 2) return setError('اكتب وصفاً للمصروف');
    const body = {
      date: form.date,
      amount: form.amount,
      category: form.category,
      description: form.description.trim() || undefined,
      invoiceNumber: form.invoiceNumber.trim() || undefined,
      vendor: form.vendor.trim() || undefined,
    };
    try {
      if (editing) await api.patch(`/admin/finance/expenses/${expense._id}`, body);
      else await api.post('/admin/finance/expenses', body);
      toast.success(editing ? 'تم تعديل المصروف' : 'تمت إضافة المصروف');
      onSaved();
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    }
  });

  return (
    <Modal
      open
      title={editing ? 'تعديل مصروف' : 'إضافة مصروف (فاتورة)'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button loading={saving} onClick={save}>
            حفظ
          </Button>
        </>
      }
    >
      <Field label="تاريخ الفاتورة" required>
        {(id) => <input id={id} className="input" type="date" value={form.date} onChange={(e) => set('date')(e.target.value)} />}
      </Field>
      <Field label="المبلغ (ج.م)" required>
        {(id) => <MoneyInput id={id} value={form.amount} onChange={set('amount')} />}
      </Field>
      <Field label="نوع المصروف" required>
        {(id) => (
          <select id={id} className="input" value={form.category} onChange={(e) => set('category')(e.target.value)}>
            <option value="">اختر...</option>
            {Object.entries(EXPENSE_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="الوصف">
        {(id) => <textarea id={id} className="input" rows={2} value={form.description} onChange={(e) => set('description')(e.target.value)} />}
      </Field>
      <Field label="رقم الفاتورة">
        {(id) => <input id={id} className="input" value={form.invoiceNumber} onChange={(e) => set('invoiceNumber')(e.target.value)} />}
      </Field>
      <Field label="المورد / الجهة" error={error}>
        {(id) => <input id={id} className="input" value={form.vendor} onChange={(e) => set('vendor')(e.target.value)} />}
      </Field>
    </Modal>
  );
}

export function FinancePage() {
  const toast = useToast();
  const [range, setRange] = useState(() => monthRange(0));
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null | {} (new) | expense
  const [deleting, setDeleting] = useState(null);

  const query = toQuery(range);
  const summary = useAsync(() => api.get('/admin/finance/summary', query), [range.from, range.to]);
  const expenses = useAsync(() => api.get('/admin/finance/expenses', { ...query, page, limit: 20 }), [range.from, range.to, page]);

  const reloadAll = () => {
    summary.reload({ silent: true });
    expenses.reload({ silent: true });
  };

  const changeRange = (next) => {
    setRange(next);
    setPage(1);
  };

  const [remove, removing] = useAction(async () => {
    try {
      await api.post(`/admin/finance/expenses/${deleting._id}/delete`, {});
      toast.success('تم حذف المصروف');
      setDeleting(null);
      reloadAll();
    } catch (err) {
      toast.error(err.message);
    }
  });

  const s = summary.data;

  return (
    <>
      <PageHeader
        title="الأرباح والمصروفات"
        subtitle="صافي الربح = مبيعات الطلبات المُسلَّمة − المصروفات (الفواتير)"
        actions={<Button onClick={() => setEditing({})}>+ إضافة مصروف</Button>}
      />

      <Card>
        <div className="filters">
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant="secondary" onClick={() => changeRange(p.range())}>
              {p.label}
            </Button>
          ))}
          <label className="filters__date">
            <span>من</span>
            <input className="input" type="date" value={range.from} onChange={(e) => changeRange({ ...range, from: e.target.value })} />
          </label>
          <label className="filters__date">
            <span>إلى</span>
            <input className="input" type="date" value={range.to} onChange={(e) => changeRange({ ...range, to: e.target.value })} />
          </label>
        </div>
      </Card>

      {summary.loading && !s ? (
        <LoadingState />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={summary.reload} />
      ) : (
        <>
          <div className="stats-grid">
            <StatCard
              label="المبيعات (طلبات مُسلَّمة)"
              value={formatMoney(s.sales.amount)}
              tone="info"
              hint={`${formatNumber(s.sales.deliveredOrders)} طلب`}
            />
            <StatCard label="المصروفات" value={formatMoney(s.expenses.total)} tone="warning" hint={`${formatNumber(s.expenses.count)} فاتورة`} />
            <StatCard label="صافي الربح" value={formatMoney(s.netProfit)} tone={s.netProfit >= 0 ? 'success' : 'danger'} />
            <StatCard
              label="النقدية المستلمة من المندوبين"
              value={formatMoney(s.cash.received)}
              hint={`صافي النقدية بعد المصروفات: ${formatMoney(s.cash.net)}`}
            />
            <StatCard label="مرتجعات في الفترة" value={formatNumber(s.sales.returnedOrders)} tone={s.sales.returnedOrders ? 'danger' : 'neutral'} />
          </div>
          <Card title="المصروفات حسب النوع" padded={false}>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {s.expenses.byCategory
                    .filter((c) => c.amount > 0)
                    .map((c) => (
                      <tr key={c.category}>
                        <td>{label(EXPENSE_CATEGORY_LABELS, c.category)}</td>
                        <td className="muted">{formatNumber(c.count)} فاتورة</td>
                        <td className="nowrap">{formatMoney(c.amount)}</td>
                      </tr>
                    ))}
                  {!s.expenses.byCategory.some((c) => c.amount > 0) && (
                    <tr>
                      <td className="muted">لا توجد مصروفات في هذه الفترة</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Card title="فواتير المصروفات" padded={false}>
        {expenses.loading && !expenses.data ? (
          <LoadingState />
        ) : expenses.error ? (
          <ErrorState error={expenses.error} onRetry={expenses.reload} />
        ) : !expenses.data.items.length ? (
          <EmptyState title="لا توجد مصروفات في هذه الفترة" description="أضف فاتورة بالضغط على (إضافة مصروف)." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>النوع</th>
                  <th>الوصف</th>
                  <th>رقم الفاتورة / المورد</th>
                  <th>المبلغ</th>
                  <th>أضافه</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expenses.data.items.map((e) => (
                  <tr key={e._id}>
                    <td className="nowrap">{formatDate(e.date)}</td>
                    <td>{label(EXPENSE_CATEGORY_LABELS, e.category)}</td>
                    <td>{e.description || '—'}</td>
                    <td className="small">{[e.invoiceNumber, e.vendor].filter(Boolean).join(' — ') || '—'}</td>
                    <td className="nowrap">{formatMoney(e.amount, e.currency)}</td>
                    <td className="muted">{e.createdBy?.name || '—'}</td>
                    <td>
                      <div className="action-list">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>
                          تعديل
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(e)}>
                          حذف
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={expenses.data?.pagination} onPage={setPage} />
      </Card>

      {editing && (
        <ExpenseModal
          expense={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAll();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="حذف المصروف"
        message={deleting ? `سيتم حذف مصروف بقيمة ${formatMoney(deleting.amount)} من حساب صافي الربح.` : ''}
        confirmLabel="حذف"
        tone="danger"
        loading={removing}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
      />
    </>
  );
}
