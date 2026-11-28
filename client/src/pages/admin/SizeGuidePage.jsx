import { PageTabs } from '../../components/PageTabs.jsx';
import { useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { Button, Card, Field, PageHeader } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { usePermissions } from '../../features/auth/permissions.js';

/**
 * «صفحة المقاسات»: models, sizes, insole lengths and every text of the
 * storefront size guide. Product photos and stock still come from EasyOrders.
 */

const TEXTS = [
  ['heroTitle', 'العنوان الرئيسي'],
  ['heroAccent', 'الجزء الملوّن من العنوان'],
  ['heroText', 'السطر تحت العنوان', true],
  ['inputLabel', 'عنوان خانة طول القدم'],
  ['inputHint', 'الملاحظة تحت العنوان'],
  ['button', 'زرار الحساب'],
  ['howTitle', 'عنوان طريقة القياس'],
  ['tip', 'النصيحة بعد الخطوات', true],
  ['colFoot', 'عنوان عمود طول القدم'],
  ['colInsole', 'عنوان عمود طول الفرش'],
  ['colSize', 'عنوان عمود المقاس'],
  ['whyTitle', 'عنوان «لماذا نضيف مساحة»'],
  ['whyText', 'شرح مساحة الراحة', true],
  ['caption1', 'شرح الرسم: الخطوة 1'],
  ['caption2', 'شرح الرسم: الخطوة 2'],
  ['caption3', 'شرح الرسم: الخطوة 3'],
  ['ctaText', 'صفحة المنتج: النص', true],
  ['ctaButton', 'صفحة المنتج: الزرار'],
];

const num = (v) => (v === '' ? '' : Number(v));

export function SizeGuidePage() {
  const canEdit = usePermissions().can('siteSettings', 'edit');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/size-guide'), []);
  const [draft, setDraft] = useState({ base: null, value: null });
  const [newSize, setNewSize] = useState('');
  const [issues, setIssues] = useState([]);
  const form = data ? (draft.base === data ? draft.value : data.guide) : null;
  const update = (fn) =>
    setDraft((d) => {
      const next = structuredClone(d.base === data ? d.value : data.guide);
      fn(next);
      return { base: data, value: next };
    });

  const [save, saving] = useAction(async () => {
    setIssues([]);
    try {
      await api.patch('/admin/size-guide', form);
      toast.success('تم الحفظ. التغيير يظهر على الموقع خلال دقيقة تقريبًا.');
      reload({ silent: true });
    } catch (err) {
      setIssues(err.details || []);
      toast.error(err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!form) return <LoadingState />;

  const dirty = JSON.stringify(form) !== JSON.stringify(data.guide);
  const sizes = form.sizes.map((s) => s.size);

  const addSize = () => {
    const size = Number(newSize);
    if (!Number.isInteger(size) || size < 15 || size > 55 || sizes.includes(size)) {
      toast.error('اكتب مقاسًا جديدًا بين 15 و55');
      return;
    }
    update((f) => {
      f.sizes.push({ size, visible: true });
      f.sizes.sort((a, b) => a.size - b.size);
    });
    setNewSize('');
  };

  const addModel = () => {
    const id = `m${Date.now().toString(36)}`;
    update((f) => {
      f.models.push({
        id,
        name: 'موديل جديد',
        sub: '',
        color: '#4A5140',
        skuPrefix: 'SKU',
        visible: true,
        mm: {},
      });
    });
    const next = new URLSearchParams(params);
    next.set('model', id);
    setParams(next, { replace: true });
  };

  const input = (label, value, onChange, props = {}) => (
    <Field label={label}>
      {(id) => <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} {...props} />}
    </Field>
  );

  const textFields = (keys) =>
    TEXTS.filter(([key]) => keys.includes(key)).map(([key, label, long]) => (
      <Field key={key} label={label}>
        {(id) => {
          const Tag = long ? 'textarea' : 'input';
          return (
            <Tag id={id} className="input" rows={long ? 3 : undefined} value={form.texts[key]} onChange={(e) => update((f) => { f.texts[key] = e.target.value; })} />
          );
        }}
      </Field>
    ));

  return (
    <>
      <PageHeader title="صفحة المقاسات" subtitle="كل ما يظهر في صفحة المقاسات وبلوك المقاسات في صفحة المنتج. الصور والمخزون من EasyOrders." />

      {issues.length > 0 && (
        <Card title="لم يتم الحفظ">
          <ul>
            {issues.map((i, n) => (
              <li key={n}>
                {i.path}: {i.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PageTabs
        label="أقسام صفحة المقاسات"
        tabs={[
          { key: 'sizes', label: 'المقاسات', content: <>
      <Card title="المقاسات">
        <p className="muted small">إضافة مقاس هنا لا تضيفه للمنتج: أضفه أيضًا في خيارات المنتج على EasyOrders.</p>
        {form.sizes.map((s, i) => (
          <div className="badge-row" key={s.size}>
            <strong>{s.size}</strong>
            <label className="checkbox">
              <input type="checkbox" checked={s.visible} onChange={(e) => update((f) => { f.sizes[i].visible = e.target.checked; })} />
              ظاهر
            </label>
            <Button
              size="sm"
              variant="ghost"
              disabled={form.sizes.length === 1}
              onClick={() => {
                if (!window.confirm(`حذف مقاس ${s.size} وأطواله من كل الموديلات؟`)) return;
                update((f) => {
                  f.sizes.splice(i, 1);
                  f.models.forEach((m) => delete m.mm[s.size]);
                });
              }}
            >
              حذف
            </Button>
          </div>
        ))}
        {input('مقاس جديد', newSize, setNewSize, { inputMode: 'numeric', placeholder: 'مثال: 46' })}
        <Button size="sm" variant="secondary" onClick={addSize}>
          إضافة المقاس
        </Button>
        {input('مساحة الراحة (مم)', form.margin, (v) => update((f) => { f.margin = num(v); }), { type: 'number', min: 0, max: 40 })}
      </Card>
</> },
          { key: 'models', label: 'الموديلات', content: <>
      <Button variant="secondary" onClick={addModel}>
        إضافة موديل
      </Button>

          {form.models.length > 0 && (
            <PageTabs
              label="الموديلات"
              param="model"
              level={2}
              tabs={form.models.map((m, i) => ({
                key: m.id,
                label: `${m.name}${m.sub ? ` — ${m.sub}` : ''}${m.visible ? '' : ' (مخفي)'}`,
                content: (
        <Card title={`${m.name}${m.sub ? ` — ${m.sub}` : ''}`}>
          <label className="checkbox">
            <input type="checkbox" checked={m.visible} onChange={(e) => update((f) => { f.models[i].visible = e.target.checked; })} />
            ظاهر على الموقع
          </label>
          {input('اسم الموديل', m.name, (v) => update((f) => { f.models[i].name = v; }))}
          {input('سطر إضافي (اختياري)', m.sub, (v) => update((f) => { f.models[i].sub = v; }))}
          {input('بداية رمز المنتج (SKU) على EasyOrders', m.skuPrefix, (v) => update((f) => { f.models[i].skuPrefix = v; }), { dir: 'ltr' })}
          {input('لون الدائرة', m.color, (v) => update((f) => { f.models[i].color = v; }), { type: 'color' })}
          <p className="muted small">طول الفرشة من الداخل (مم). اترك الخانة فارغة إذا كان المقاس غير متوفر في هذا الموديل.</p>
          <div className="badge-row">
            {sizes.map((size) => (
              <label key={size}>
                {size}
                <input
                  className="input"
                  type="number"
                  style={{ width: 90 }}
                  value={m.mm[size] ?? ''}
                  onChange={(e) =>
                    update((f) => {
                      if (e.target.value === '') delete f.models[i].mm[size];
                      else f.models[i].mm[size] = Number(e.target.value);
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="badge-row">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => update((f) => { [f.models[i - 1], f.models[i]] = [f.models[i], f.models[i - 1]]; })}>
              ↑ أعلى
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.confirm(`حذف ${m.name}؟`) && update((f) => { f.models.splice(i, 1); })}
            >
              حذف الموديل
            </Button>
          </div>
        </Card>
                ),
              }))}
            />
          )}
        </> },
          { key: 'texts', label: 'النصوص', content: (
          <PageTabs
            label="النصوص"
            param="text"
            level={2}
            tabs={[
              { key: 'hero', label: 'أعلى الصفحة', content: <Card>
              {textFields(['heroTitle', 'heroAccent', 'heroText', 'inputLabel', 'inputHint', 'button'])}
            </Card> },
              { key: 'how', label: 'طريقة القياس', content: <Card>
              {textFields(['howTitle', 'tip'])}
        {form.texts.steps.map((step, i) => (
          <div key={i}>
            {input(`خطوة القياس ${i + 1}`, step, (v) => update((f) => { f.texts.steps[i] = v; }))}
            <Button size="sm" variant="ghost" onClick={() => update((f) => { f.texts.steps.splice(i, 1); })}>
              حذف الخطوة
            </Button>
          </div>
        ))}
        {form.texts.steps.length < 8 && (
          <Button size="sm" variant="secondary" onClick={() => update((f) => { f.texts.steps.push('خطوة جديدة'); })}>
            إضافة خطوة
          </Button>
        )}
            </Card> },
              { key: 'table', label: 'الجدول', content: <Card>
              {textFields(['colFoot', 'colInsole', 'colSize'])}
            </Card> },
              { key: 'why', label: 'مساحة الراحة والرسم', content: <Card>
              {textFields(['whyTitle', 'whyText', 'caption1', 'caption2', 'caption3'])}
            </Card> },
              { key: 'product', label: 'صفحة المنتج', content: <Card>
              {textFields(['ctaText', 'ctaButton'])}
            </Card> },
            ]}
          />
        ) },
        ]}
      />

      {canEdit && (
        <div className="sticky-actions">
          <Button onClick={save} loading={saving} disabled={!dirty} size="lg">
            حفظ التغييرات
          </Button>
        </div>
      )}
    </>
  );
}
