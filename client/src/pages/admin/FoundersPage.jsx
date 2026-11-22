import { useState } from 'react';
import { Badge, Button, Card, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDate, formatNumber, orderNumber } from '../../utils/format.js';

/**
 * «أوائل سوليتا»: the first customers whose order was delivered. The number
 * is assigned automatically on delivery approval. The owner creates two
 * coupons per founder in EasyOrders and records their codes here:
 *  - personal code: the member discount for 12 months;
 *  - friend code: a discount for a friend; each order using it is one more
 *    entry in the draw.
 */
function FounderRow({ founder, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ personalCode: founder.personalCode || '', friendCode: founder.friendCode || '', notes: founder.notes || '' });
  const [saving, setSaving] = useState(false);
  const dirty =
    form.personalCode !== (founder.personalCode || '') ||
    form.friendCode !== (founder.friendCode || '') ||
    form.notes !== (founder.notes || '');

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/founders/${founder._id}`, form);
      toast.success('تم الحفظ');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };
  const expired = new Date(founder.benefitUntil) < new Date();
  const input = (key, label) => (
    <input
      className="input"
      aria-label={label}
      placeholder={label}
      dir="ltr"
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
    />
  );

  return (
    <tr>
      <td className="nowrap">
        <strong>#{formatNumber(founder.number)}</strong>
      </td>
      <td>
        {founder.name || <span className="muted">—</span>}
        <div className="muted mono small" dir="ltr">
          {founder.phoneNormalized}
        </div>
      </td>
      <td className="nowrap muted">
        {formatDate(founder.joinedAt)}
        {founder.order?.easyOrdersShortId || founder.order?.easyOrdersId ? (
          <div className="small">طلب {orderNumber(founder.order)}</div>
        ) : null}
      </td>
      <td>
        {input('personalCode', 'كود المؤسس')}
        <div className="muted small">
          {founder.personalCode ? `استُخدم ${formatNumber(founder.personalUses)} مرة · ` : ''}
          <Badge tone={expired ? 'muted' : 'success'}>{expired ? 'انتهت المزايا' : `حتى ${formatDate(founder.benefitUntil)}`}</Badge>
        </div>
      </td>
      <td>
        {input('friendCode', 'كود الصاحب')}
        <div className="muted small">
          {formatNumber(founder.referrals)} طلب بالكود · فرص السحب: {formatNumber(founder.drawEntries)}
        </div>
      </td>
      <td>{input('notes', 'ملاحظات')}</td>
      <td>
        <Button size="sm" loading={saving} disabled={!dirty} onClick={save}>
          حفظ
        </Button>
      </td>
    </tr>
  );
}

export function FoundersPage() {
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/founders'), []);
  const s = data?.summary;

  return (
    <>
      <PageHeader
        title="أوائل سوليتا"
        subtitle="أول العملاء الذين تم تسليم طلبهم. يُعطى الرقم تلقائيًا عند الموافقة على التسليم. أنشئ لكل مؤسس كوبونين في EasyOrders (للمؤسس ولصاحبه) وسجّل الكودين هنا، والنسبة والحد الأقصى من «إعدادات الموقع»."
      />
      {s ? (
        <Card>
          <div className="badge-row">
            <Badge tone="info">
              {formatNumber(s.taken)} من {formatNumber(s.cap)}
            </Badge>
            <Badge tone="neutral">المتبقي {formatNumber(s.remaining)}</Badge>
            <Badge tone={s.showCounter ? 'success' : 'muted'}>{s.showCounter ? 'العداد ظاهر على الموقع' : 'العداد مخفي على الموقع'}</Badge>
            {!s.enabled ? <Badge tone="warning">البرنامج متوقف</Badge> : null}
          </div>
        </Card>
      ) : null}
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا يوجد مؤسسون بعد" description="يظهر أول مؤسس عند الموافقة على أول تسليم." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الرقم</th>
                  <th>العميل</th>
                  <th>الانضمام</th>
                  <th>كود المؤسس</th>
                  <th>كود الصاحب</th>
                  <th>ملاحظات</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((f) => (
                  <FounderRow key={f._id} founder={f} onSaved={() => reload({ silent: true })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
