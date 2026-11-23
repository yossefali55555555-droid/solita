import { useState } from 'react';
import { Badge, Button, Card, DefinitionList } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime } from '../../utils/format.js';

const LEVELS = {
  new: { tone: 'neutral', text: 'عميل جديد', hint: 'لا توجد طلبات سابقة لهذا الرقم' },
  unknown: { tone: 'neutral', text: 'طلبات سابقة بدون نتيجة', hint: 'له طلبات سابقة لم تُسلَّم أو تُرفض بعد' },
  good: { tone: 'success', text: 'عميل موثوق', hint: 'استلم طلبات سابقة ولم يرفض أي طلب' },
  moderate: { tone: 'warning', text: 'خطورة متوسطة', hint: 'رفض أو أُرجع طلب سابق' },
  high: { tone: 'danger', text: 'خطورة عالية', hint: 'رفض أكثر من طلب أو نسبة استلامه ضعيفة' },
};

/** Small badge for lists. Shows nothing for brand-new customers. */
export function CustomerRiskBadge({ history }) {
  if (!history || history.level === 'new') return null;
  const l = LEVELS[history.level];
  return (
    <Badge tone={l.tone} title={`${l.hint} · استلم ${history.delivered} · رفض ${history.refused}`}>
      {l.text}
    </Badge>
  );
}

export function CustomerRecordCard({ history }) {
  if (!history) return null;
  const l = LEVELS[history.level];
  return (
    <Card title="سجل العميل مع سوليتا">
      <p>
        <Badge tone={l.tone}>{l.text}</Badge> <span className="muted">{l.hint}</span>
      </p>
      <DefinitionList
        items={[
          ['طلبات سابقة', history.previous],
          ['استلمها', history.delivered],
          ['رفضها أو رُجِّعت', history.refused],
          ['ألغاها', history.cancelled],
          ['قيد التنفيذ', history.open],
          ['نسبة التسليم', history.rate === null ? '—' : `${history.rate}%`],
        ]}
      />
      <p className="muted">محسوبة من طلبات هذا الرقم عندنا فقط، وبدون الطلبات التجريبية.</p>
    </Card>
  );
}

function duration(seconds) {
  if (seconds === undefined || seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} دقيقة`;
}

export function SessionCard({ order, onChanged }) {
  const toast = useToast();
  const s = order.session;
  const [refresh, refreshing] = useAction(async () => {
    try {
      await api.post('/admin/easyorders/import', { orderId: order.easyOrdersId });
      toast.success('تم تحديث بيانات الطلب من EasyOrders');
      onChanged();
    } catch (err) {
      toast.error(err.message);
    }
  });
  const extra = s?.extra && typeof s.extra === 'object' ? Object.entries(s.extra).filter(([, v]) => typeof v === 'string' || typeof v === 'number') : [];

  return (
    <Card
      title="جلسة الزيارة"
      actions={
        <Button size="sm" variant="secondary" loading={refreshing} onClick={refresh}>
          تحديث من EasyOrders
        </Button>
      }
    >
      {!s ? (
        <p className="muted">لا توجد بيانات جلسة لهذا الطلب بعد. اضغط «تحديث من EasyOrders» لجلبها (الطلبات الجديدة تصل بها تلقائيًا).</p>
      ) : (
        <>
          <DefinitionList
            items={[
              ['الوقت المستغرق في الشراء', duration(s.visitDurationSeconds)],
              ['عدد الجلسات', s.sessionsCount ?? '—'],
              ['أول زيارة', s.firstVisitAt ? formatDateTime(s.firstVisitAt) : '—'],
              ['أول طلب', s.firstOrderAt ? formatDateTime(s.firstOrderAt) : '—'],
              ['جاء من', s.referrer || '—'],
              ['مصدر الحملة', s.utmSource || '—'],
              ['اسم الحملة', s.utmCampaign || '—'],
              ['الدولة', s.ipCountry ? s.ipCountry.toUpperCase() : '—'],
              ...extra.slice(0, 6).map(([k, v]) => [k, String(v)]),
            ]}
          />
          {s.pagesVisited?.length > 0 && (
            <>
              <h4 className="section-title">الصفحات التي زارها ({s.pagesVisited.length})</h4>
              <ol className="plain-list" dir="ltr">
                {s.pagesVisited.map((p, i) => (
                  <li key={`${p}-${i}`} className="mono">{p}</li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </Card>
  );
}

export function NotesCard({ order, onChanged }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [type, setType] = useState('private');
  const [save, saving] = useAction(async () => {
    try {
      const res = await api.post(`/admin/orders/${order._id}/notes`, { text, type });
      if (res.sync === 'failed') toast.info(`تم حفظ الملاحظة هنا لكن لم تصل EasyOrders: ${res.syncError}`);
      else toast.success(type === 'public' ? 'تمت إضافة الملاحظة وستظهر للعميل في صفحة التتبع' : 'تمت إضافة الملاحظة');
      setText('');
      onChanged();
    } catch (err) {
      toast.error(err.details?.[0]?.message || err.message);
    }
  });
  const [retry, retrying] = useAction(async (noteId) => {
    try {
      const res = await api.post(`/admin/orders/${order._id}/notes/${noteId}/retry`);
      if (res.sync === 'synced') toast.success('وصلت الملاحظة إلى EasyOrders');
      else toast.error(res.syncError || 'لم تصل بعد');
      onChanged();
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <Card title="ملاحظات الطلب">
      <div className="note-form">
        <textarea
          className="input"
          rows={3}
          maxLength={1000}
          placeholder="اكتب ملاحظة…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="نص الملاحظة"
        />
        <div className="row-between">
          <span>
            <label className="checkbox">
              <input type="radio" name="note-type" checked={type === 'private'} onChange={() => setType('private')} />
              <span>خاصة (للفريق فقط)</span>
            </label>{' '}
            <label className="checkbox">
              <input type="radio" name="note-type" checked={type === 'public'} onChange={() => setType('public')} />
              <span>عامة (تظهر للعميل في صفحة التتبع)</span>
            </label>
          </span>
          <Button loading={saving} disabled={!text.trim()} onClick={save}>
            إضافة الملاحظة
          </Button>
        </div>
        {type === 'public' && <p className="muted">انتبه: الملاحظة العامة يقرؤها العميل بنفسه.</p>}
      </div>
      {order.notes?.length > 0 ? (
        <ul className="plain-list">
          {[...order.notes].reverse().map((n) => (
            <li key={n._id}>
              <div>
                <Badge tone={n.type === 'public' ? 'info' : 'neutral'}>{n.type === 'public' ? 'عامة' : 'خاصة'}</Badge>{' '}
                {n.sync === 'failed' && <Badge tone="danger" title={n.syncError}>لم تصل EasyOrders</Badge>}{' '}
                <span className="muted">
                  {n.byName || 'مشرف'} · {formatDateTime(n.at)}
                </span>
              </div>
              <p>{n.text}</p>
              {n.sync === 'failed' && (
                <Button size="sm" variant="secondary" loading={retrying} onClick={() => retry(n._id)}>
                  إعادة الإرسال
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">لا توجد ملاحظات.</p>
      )}
    </Card>
  );
}
