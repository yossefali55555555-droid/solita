import { useMemo, useState } from 'react';
import { Badge, Button, Card, PageHeader, StatCard } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatNumber } from '../../utils/format.js';

const RANGES = [
  ['today', 'اليوم'],
  ['7d', '٧ أيام'],
  ['30d', '٣٠ يومًا'],
  ['90d', '٩٠ يومًا'],
];
const DEVICES = { mobile: 'موبايل', tablet: 'تابلت', desktop: 'كمبيوتر', unknown: 'غير معروف' };
const SOURCES = { direct: 'مباشر', instagram: 'إنستجرام', facebook: 'فيسبوك', tiktok: 'تيك توك', google: 'جوجل', whatsapp: 'واتساب', other: 'أخرى' };
const OSES = { android: 'أندرويد', ios: 'آيفون', windows: 'ويندوز', mac: 'ماك', other: 'أخرى' };
const TYPES = {
  home: 'الرئيسية',
  product: 'منتج',
  collection: 'قسم',
  page: 'صفحة',
  cart: 'السلة',
  checkout: 'الدفع',
  thanks: 'الشكر',
  track: 'التتبع',
  search: 'بحث',
  other: 'أخرى',
};
const STORE_URL = 'https://solita.myeasyorders.com';

function secs(n) {
  if (n === null || n === undefined) return '—';
  if (n < 60) return `${n} ث`;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')} د`;
}
const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);

const COLUMNS = [
  ['views', 'الزيارات'],
  ['avgSeconds', 'متوسط الوقت'],
  ['medianSeconds', 'الوسيط'],
  ['quickLeaveRate', 'خرج بسرعة (< ٣ ث)'],
  ['exitRate', 'ترك الموقع من هنا'],
  ['avgScroll', 'عمق التمرير'],
  ['addRate', 'أضاف للسلة'],
];

function Breakdown({ title, data, labels }) {
  const total = Object.values(data || {}).reduce((a, b) => a + b, 0);
  return (
    <Card title={title}>
      {!total ? (
        <p className="muted">لا توجد بيانات بعد.</p>
      ) : (
        <ul className="plain-list">
          {Object.entries(data)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <li key={k} className="row-between">
                <span>{labels[k] || k}</span>
                <span>{formatNumber(v)} <span className="muted">({Math.round((v / total) * 100)}%)</span></span>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

export function PageTimePage() {
  const [range, setRange] = useState('7d');
  const [device, setDevice] = useState('');
  const [src, setSrc] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState({ key: 'views', dir: -1 });
  const query = { range, device, src, type };
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/storefront/pages', query), [JSON.stringify(query)]);

  const rows = useMemo(() => {
    const list = [...(data?.pages || [])];
    list.sort((a, b) => {
      const av = a[sort.key] ?? -1;
      const bv = b[sort.key] ?? -1;
      return (av - bv) * sort.dir;
    });
    return list;
  }, [data, sort]);
  const th = (key, text) => (
    <th key={key}>
      <button type="button" className="link" onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>
        {text}
        {sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  );
  const f = data?.funnel;

  return (
    <>
      <PageHeader title="حركة الصفحات" subtitle="كل صفحة في المتجر وكم يقضي الزوار فيها. أي منتج أو صفحة جديدة تظهر هنا تلقائيًا أول ما يزورها أحد." actions={<Button variant="secondary" onClick={() => reload({ silent: true })}>تحديث</Button>} />

      <Card>
        <div className="filters">
          <select className="input" aria-label="الفترة" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          <select className="input" aria-label="الجهاز" value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">كل الأجهزة</option>
            {Object.entries(DEVICES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          <select className="input" aria-label="المصدر" value={src} onChange={(e) => setSrc(e.target.value)}>
            <option value="">كل المصادر</option>
            {Object.entries(SOURCES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          <select className="input" aria-label="نوع الصفحة" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">كل أنواع الصفحات</option>
            {Object.entries(TYPES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </Card>

      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <>
          <div className="stats-grid">
            <StatCard label="الرئيسية" value={formatNumber(f.home)} hint="مشاهدات صفحة" />
            <StatCard label="صفحات المنتجات" value={formatNumber(f.products)} hint="مشاهدات صفحة" />
            <StatCard label="صفحة الدفع" value={formatNumber(f.checkout)} tone="warning" hint={f.products ? `${Math.round((f.checkout / f.products) * 100)}% من مشاهدات المنتجات` : ''} />
            <StatCard label="صفحة الشكر (طلبات)" value={formatNumber(f.thanks)} tone="success" hint={f.checkout ? `${Math.round((f.thanks / f.checkout) * 100)}% ممن وصلوا للدفع` : ''} />
          </div>
          <p className="muted">الأرقام أعلاه مشاهدات صفحات وليست أشخاصًا؛ الشخص الواحد قد يشاهد الصفحة أكثر من مرة.</p>

          <div className="grid-2">
            <Breakdown title="الأجهزة" data={data.devices} labels={DEVICES} />
            <Breakdown title="نظام التشغيل" data={data.os} labels={OSES} />
          </div>
          <Breakdown title="مصدر الزيارة" data={data.sources} labels={SOURCES} />

          <Card padded={false} title="كل الصفحات">
            {!rows.length ? (
              <EmptyState title="لا توجد بيانات بعد" description="تظهر الصفحات هنا بعد أول زيارات تُسجَّل من المتجر." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>الصفحة</th>
                      <th>النوع</th>
                      {COLUMNS.map(([k, t]) => th(k, t))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.path}>
                        <td>
                          <div>{p.title || p.path}</div>
                          <div className="muted mono" dir="ltr">{p.path}</div>
                        </td>
                        <td>{TYPES[p.type]}</td>
                        <td>{formatNumber(p.views)}</td>
                        <td>
                          {secs(p.avgSeconds)} {p.lowSample && p.timed > 0 && <Badge tone="warning" title="أقل من ٣٠ زيارة مقاسة: الرقم غير موثوق بعد">عينة صغيرة</Badge>}
                        </td>
                        <td>{secs(p.medianSeconds)}</td>
                        <td>{pct(p.quickLeaveRate)}</td>
                        <td>{pct(p.exitRate)}</td>
                        <td>{pct(p.avgScroll)}</td>
                        <td>{p.addRate === null ? '—' : `${p.addRate}% (${p.adds})`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card title="كيف تُحسب الأرقام؟">
        <ul className="plain-list">
          <li><strong>الوقت</strong> هو وقت النشاط الفعلي: التاب ظاهر ويوجد تفاعل (تمرير أو لمس أو نقر) في آخر ١٥ ثانية. ترك الصفحة مفتوحة بلا تفاعل لا يُحسب.</li>
          <li><strong>الوسيط</strong> هو الرقم الأصدق؛ نصف الزوار قضى أقل منه ونصفهم أكثر. المتوسط قد يرفعه زائر واحد نسي الصفحة.</li>
          <li><strong>خرج بسرعة</strong>: زار الصفحة أقل من ٣ ثوانٍ. نسبة عالية في صفحة منتج تعني أن أول ما تراه العين لا يشدّ.</li>
          <li><strong>ترك الموقع من هنا</strong>: آخر صفحة شاهدها قبل أن يغادر المتجر أو يبدّل إلى تطبيق آخر (مثل واتساب).</li>
          <li><strong>عمق التمرير</strong>: متوسط أبعد نقطة وصل إليها الزائر في الصفحة (١٠٠٪ = نهايتها). مهم جدًا لصفحة المنتج الطويلة.</li>
          <li>«عينة صغيرة» = أقل من ٣٠ زيارة مقاسة؛ لا تبنِ قرارًا عليها.</li>
        </ul>
      </Card>

      <Card title="استبعاد أجهزتك أنت والفريق">
        <p>
          أنتم تفتحون الموقع من Chrome مثل أي عميل، فيُحسب دخولكم زيارة. للاستبعاد: افتح هذا الرابط <strong>مرة واحدة على كل جهاز</strong> (كمبيوتر، موبايل…) وبعدها يتوقف ذلك المتصفح عن الإرسال:
        </p>
        <p><a className="link mono" dir="ltr" href={`${STORE_URL}/?notrack=1`} target="_blank" rel="noopener noreferrer">{STORE_URL}/?notrack=1</a></p>
        <p className="muted">للعودة للتسجيل على ذلك الجهاز: <span className="mono" dir="ltr">?notrack=0</span>. لو غيّرت المتصفح أو مسحت بياناته كرّر الخطوة.</p>
      </Card>
    </>
  );
}
