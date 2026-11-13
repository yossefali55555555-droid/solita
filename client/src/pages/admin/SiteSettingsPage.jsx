import { useState } from 'react';
import { Button, Card, Field, PageHeader } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime } from '../../utils/format.js';

/**
 * «إعدادات الموقع»: everything on the storefront that EasyOrders itself
 * cannot control. The site reads these through /api/public/site-config
 * (cached for one minute) and keeps its last copy if the system is down.
 * Website texts are Modern Standard Arabic with an English version.
 */

const SPEEDS = [
  { value: 'slow', label: 'بطيئة' },
  { value: 'normal', label: 'عادية' },
  { value: 'fast', label: 'سريعة' },
];
const ORDERS = [
  { value: 'random', label: 'عشوائي في كل زيارة' },
  { value: 'easyorders', label: 'بترتيب EasyOrders' },
];
const TOGGLES = [
  ['shelf', 'الرف في الصفحة الرئيسية'],
  ['cards', 'كروت المنتجات المتحركة'],
  ['sounds', 'الأصوات'],
  ['trackingBubble', 'فقاعة تتبع الطلب'],
];
const FEATURES = [
  ['shipping', 'الشحن'],
  ['customerCare', 'خدمة العملاء'],
  ['warranty', 'الضمان'],
  ['payment', 'الدفع'],
];

const clone = (v) => JSON.parse(JSON.stringify(v));

function setPath(obj, path, value) {
  const next = clone(obj);
  let cur = next;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i]];
  cur[path.at(-1)] = value;
  return next;
}

const splitSkus = (v) =>
  v
    .split(/[\s,،]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function LocalizedInput({ label, value, onChange, multiline = false, hint }) {
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="localized">
          <Tag
            id={id}
            className="input"
            dir="rtl"
            rows={multiline ? 2 : undefined}
            placeholder="بالعربية"
            value={value.ar}
            onChange={(e) => onChange({ ...value, ar: e.target.value })}
          />
          <Tag
            className="input"
            dir="ltr"
            lang="en"
            rows={multiline ? 2 : undefined}
            placeholder="English"
            aria-label={`${label} (English)`}
            value={value.en}
            onChange={(e) => onChange({ ...value, en: e.target.value })}
          />
        </div>
      )}
    </Field>
  );
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function SiteSettingsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/site-settings'), []);
  // The draft belongs to the loaded data; a reload (after saving) starts a fresh draft.
  const [draft, setDraft] = useState({ base: null, value: null });
  const form = data ? (draft.base === data ? draft.value : data.settings) : null;
  const setForm = (fn) =>
    setDraft((d) => ({ base: data, value: fn(d.base === data ? d.value : data.settings) }));
  const [issues, setIssues] = useState([]);

  const [save, saving] = useAction(async () => {
    setIssues([]);
    try {
      await api.patch('/admin/site-settings', form);
      toast.success('تم حفظ إعدادات الموقع. ستظهر على الموقع خلال دقيقة تقريبًا.');
      reload({ silent: true });
    } catch (err) {
      setIssues(err.details || []);
      toast.error(err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!form) return <LoadingState />;

  const set = (path) => (value) => setForm((f) => setPath(f, path, value));
  const skuOptions = [
    ...new Set(
      [...data.defaults.shelf.lines, ...form.shelf.lines].flatMap((l) => [l.sku, ...l.fallbacks]).filter(Boolean),
    ),
  ];
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);

  return (
    <>
      <PageHeader
        title="إعدادات الموقع"
        subtitle="كل ما يظهر على الموقع ولا يمكن التحكم فيه من EasyOrders. المنتجات والأسعار والمخزون وسعر الشحن المجاني تبقى في EasyOrders."
        actions={
          <>
            <Button variant="ghost" onClick={() => setForm(() => clone(data.defaults))}>
              استعادة الإعدادات الافتراضية
            </Button>
            <Button onClick={save} loading={saving} disabled={!dirty}>
              حفظ التغييرات
            </Button>
          </>
        }
      />
      <p className="muted small">
        آخر حفظ: {data.updatedAt ? `${formatDateTime(data.updatedAt)}${data.updatedBy?.name ? ` · ${data.updatedBy.name}` : ''}` : 'لم تُحفظ بعد (الموقع يستخدم الإعدادات الافتراضية)'}
      </p>
      {issues.length > 0 && (
        <div className="alert alert--danger" role="alert">
          <strong>راجع الحقول التالية:</strong>
          <ul>
            {issues.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <span className="mono" dir="ltr">
                  {i.path}
                </span>{' '}
                — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card title="تشغيل وإيقاف">
        {TOGGLES.map(([key, label]) => (
          <Toggle key={key} checked={form.toggles[key]} onChange={set(['toggles', key])}>
            {label}
          </Toggle>
        ))}
      </Card>

      <Card title="الرفوف">
        <p className="muted small">
          لكل رف حذاء أساسي، وبعده البدائل بالترتيب. إذا نفد الأساسي يظهر أول بديل متوفر. اكتب رمز المنتج (SKU) كما هو في EasyOrders، وافصل البدائل بفاصلة.
        </p>
        <datalist id="shelf-skus">
          {skuOptions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {form.shelf.lines.map((line, i) => (
          <div className="inline-form" key={i}>
            <Field label={`الرف ${i + 1}`}>
              {(id) => (
                <input
                  id={id}
                  className="input mono"
                  dir="ltr"
                  list="shelf-skus"
                  value={line.sku}
                  onChange={(e) => set(['shelf', 'lines', i, 'sku'])(e.target.value.trim())}
                />
              )}
            </Field>
            <Field label="البدائل بالترتيب">
              {(id) => (
                <input
                  id={id}
                  className="input mono"
                  dir="ltr"
                  value={line.fallbacks.join(', ')}
                  onChange={(e) => set(['shelf', 'lines', i, 'fallbacks'])(splitSkus(e.target.value))}
                />
              )}
            </Field>
          </div>
        ))}
      </Card>

      <Card title="الكروت والمقترحات">
        <div className="inline-form">
          <Field label="سرعة الكروت">
            {(id) => (
              <select id={id} className="input" value={form.cards.speed} onChange={(e) => set(['cards', 'speed'])(e.target.value)}>
                {SPEEDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="عدد «مقترحات لك»">
            {(id) => (
              <input
                id={id}
                className="input"
                type="number"
                min={0}
                max={24}
                value={form.suggestions.count}
                onChange={(e) => set(['suggestions', 'count'])(Math.max(0, Math.min(24, Number(e.target.value) || 0)))}
              />
            )}
          </Field>
          <Field label="ترتيب المقترحات">
            {(id) => (
              <select
                id={id}
                className="input"
                value={form.suggestions.order}
                onChange={(e) => set(['suggestions', 'order'])(e.target.value)}
              >
                {ORDERS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Card>

      <Card title="رسائل السلة">
        <p className="muted small">
          عندما يعود زائر وفي سلته منتجات، تظهر له رسالة واحدة في كل زيارة بالترتيب: الزيارة الأولى الرسالة الأولى، ثم الثانية، وهكذا.
        </p>
        <Toggle checked={form.cartReminder.enabled} onChange={set(['cartReminder', 'enabled'])}>
          إظهار رسائل السلة
        </Toggle>
        {form.cartReminder.messages.map((m, i) => (
          <div key={i}>
            <LocalizedInput label={`الرسالة ${i + 1}`} value={m} multiline onChange={set(['cartReminder', 'messages', i])} />
            <div className="badge-row">
              <Button
                size="sm"
                variant="ghost"
                disabled={i === 0}
                onClick={() => {
                  const list = [...form.cartReminder.messages];
                  [list[i - 1], list[i]] = [list[i], list[i - 1]];
                  set(['cartReminder', 'messages'])(list);
                }}
              >
                ↑ أعلى
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => set(['cartReminder', 'messages'])(form.cartReminder.messages.filter((_, j) => j !== i))}
              >
                حذف
              </Button>
            </div>
          </div>
        ))}
        {form.cartReminder.messages.length < 10 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => set(['cartReminder', 'messages'])([...form.cartReminder.messages, { ar: '', en: '' }])}
          >
            إضافة رسالة
          </Button>
        )}
      </Card>

      <Card title="شريط العروض أعلى الموقع">
        <Toggle checked={form.announcement.enabled} onChange={set(['announcement', 'enabled'])}>
          إظهار الشريط
        </Toggle>
        <LocalizedInput label="النص" value={form.announcement.text} onChange={set(['announcement', 'text'])} />
        <Field label="الرابط (اختياري)" hint="مثال: /collections/sneakers-for-men أو رابط يبدأ بـ https://">
          {(id) => (
            <input
              id={id}
              className="input mono"
              dir="ltr"
              value={form.announcement.link}
              onChange={(e) => set(['announcement', 'link'])(e.target.value)}
            />
          )}
        </Field>
      </Card>

      <Card title="نصوص المميزات">
        {FEATURES.map(([key, label]) => (
          <fieldset className="checklist" key={key}>
            <legend>{label}</legend>
            <LocalizedInput label="العنوان" value={form.features[key].title} onChange={set(['features', key, 'title'])} />
            <LocalizedInput label="الوصف" value={form.features[key].text} onChange={set(['features', key, 'text'])} />
          </fieldset>
        ))}
      </Card>

      <Card title="الهدية مع الحذاء">
        <LocalizedInput label="العنوان" value={form.gift.title} onChange={set(['gift', 'title'])} />
        <LocalizedInput label="الوصف" value={form.gift.text} onChange={set(['gift', 'text'])} />
      </Card>

      <Card title="واتساب">
        <Field label="حساب أو رقم واتساب الظاهر على الموقع">
          {(id) => (
            <input
              id={id}
              className="input mono"
              dir="ltr"
              value={form.whatsapp.account}
              onChange={(e) => set(['whatsapp', 'account'])(e.target.value)}
            />
          )}
        </Field>
        <LocalizedInput
          label="الرسالة الجاهزة من صفحة منتج"
          hint="{product} يُستبدل باسم الحذاء"
          multiline
          value={form.whatsapp.productMessage}
          onChange={set(['whatsapp', 'productMessage'])}
        />
        <LocalizedInput
          label="الرسالة الجاهزة من باقي الصفحات"
          multiline
          value={form.whatsapp.generalMessage}
          onChange={set(['whatsapp', 'generalMessage'])}
        />
      </Card>

      <Card title="مدة التوصيل">
        <LocalizedInput label="النص المكتوب على الموقع" multiline value={form.delivery.text} onChange={set(['delivery', 'text'])} />
      </Card>

      <Card title="رسالة واتساب للسلات المتروكة (داخل اللوحة فقط)">
        <Field label="نص الرسالة" hint="{name} الاسم الأول، {items} المنتجات والمقاسات، {total} الإجمالي. لا تظهر على الموقع.">
          {(id) => (
            <textarea
              id={id}
              className="input"
              rows={5}
              value={form.admin.cartWhatsappTemplate}
              onChange={(e) => set(['admin', 'cartWhatsappTemplate'])(e.target.value)}
            />
          )}
        </Field>
      </Card>

      <div className="sticky-actions">
        <Button onClick={save} loading={saving} disabled={!dirty} size="lg">
          حفظ التغييرات
        </Button>
      </div>
    </>
  );
}
