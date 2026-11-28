import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Modal, PageHeader, Pagination } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useAction, useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api, downloadFile } from '../../services/api.js';
import { usePermissions } from '../../features/auth/permissions.js';
import { formatDateTime } from '../../utils/format.js';
import { logWhatsAppClick, whatsappLink } from '../../features/whatsapp/whatsapp.js';
import { fileToImportText } from '../../utils/spreadsheet.js';

const FILTER_KEYS = ['status', 'priority', 'reason', 'test', 'q', 'page'];

const PRIORITY = {
  hot: { tone: 'success', text: 'يستاهل التواصل' },
  done: { tone: 'neutral', text: 'اشترى بعدها' },
  unreachable: { tone: 'warning', text: 'مفيش رقم صالح' },
  likely_test: { tone: 'demo', text: 'غالبًا تجربة' },
};

const missedMessage = (name) =>
  `أهلاً ${name ? name.split(/\s+/)[0] : ''}،\nمعك فريق سوليتا. لاحظنا أنك حاولت إتمام طلبك ولم يكتمل.\nهل واجهتك مشكلة؟ يسعدنا مساعدتك في إتمامه.`.replace('أهلاً ،', 'أهلاً،');

function ImportModal({ open, onClose, onDone, prefill }) {
  const toast = useToast();
  const [text, setText] = useState(prefill?.text || '');
  const [fileName, setFileName] = useState(prefill?.name || '');
  const [error, setError] = useState(prefill?.error || '');
  const [result, setResult] = useState(null);
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const [run, running] = useAction(async () => {
    setError('');
    try {
      const res = await api.post('/admin/missed-orders/import', { text });
      setResult(res);
      setText('');
      setFileName('');
      toast.success(`${res.created} جديدة، ${res.existing} موجودة من قبل`);
      onDone();
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    }
  });

  const readFile = async (file) => {
    if (!file) return;
    setResult(null);
    setError('');
    setReading(true);
    try {
      setText(await fileToImportText(file));
      setFileName(file.name);
    } catch (err) {
      setText('');
      setFileName('');
      setError(err.message || 'تعذر قراءة الملف');
    } finally {
      setReading(false);
    }
  };

  const close = () => {
    setResult(null);
    setError('');
    setText('');
    setFileName('');
    onClose();
  };
  const rowCount = text ? Math.max(0, text.split('\n').filter((l) => l.trim()).length - 1) : 0;

  return (
    <Modal
      open={open}
      title="استيراد الطلبات المفقودة من EasyOrders"
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>إغلاق</Button>
          <Button loading={running} disabled={text.trim().length < 10 || reading} onClick={run}>استيراد</Button>
        </>
      }
    >
      <ol className="plain-list">
        <li>في EasyOrders افتح «الطلبات المفقودة» واضغط «تصدير».</li>
        <li>اسحب الملف (xlsx أو csv) وأفلته هنا، أو اضغط لاختياره. يمكنك استيراد نفس الملف أكثر من مرة: الصفوف الموجودة لا تتكرر ولا تتغير حالتها.</li>
      </ol>
      <div
        className={`dropzone ${over ? 'dropzone--over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files?.[0]); }}
      >
        {reading ? 'جاري قراءة الملف…' : fileName ? <><strong>{fileName}</strong> · {rowCount} صف جاهز للاستيراد</> : 'اسحب الملف هنا وأفلته (xlsx / csv / txt) أو اضغط للاختيار'}
        <input ref={input} type="file" hidden accept=".xlsx,.csv,.txt,.tsv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="ملف التصدير" />
      </div>
      <textarea className="input" rows={5} dir="ltr" placeholder="أو الصق محتوى الجدول هنا" value={text} onChange={(e) => { setText(e.target.value); setFileName(''); }} aria-label="محتوى الملف" />
      {error && <div className="alert alert--danger" role="alert">{error}</div>}
      {result && (
        <div className="alert alert--info" role="status">
          تم: <strong>{result.created}</strong> جديدة، <strong>{result.existing}</strong> موجودة من قبل
          {result.skipped ? `، وتم تخطي ${result.skipped} صف ناقص` : ''}.
        </div>
      )}
    </Modal>
  );
}

export function MissedOrdersPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));
  const [search, setSearch] = useState(filters.q);
  const q = useDebouncedValue(search);
  const query = { ...filters, q, limit: 25 };
  const key = JSON.stringify(query);
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/missed-orders', query), [key]);
  const [selected, setSelected] = useState(() => new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [prefill, setPrefill] = useState(null);

  // Drop a file anywhere on the page to import it.
  useEffect(() => {
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const over = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      fileToImportText(file)
        .then((text) => setPrefill({ text, name: file.name, key: Date.now() }))
        .catch((err) => setPrefill({ text: '', name: '', error: err.message || 'تعذر قراءة الملف', key: Date.now() }))
        .finally(() => setImportOpen(true));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);

  const update = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const status = filters.status || 'open';
  const ids = (data?.items || []).map((i) => i._id);
  const allOnPage = ids.length > 0 && ids.every((i) => selected.has(i));
  const toggle = (id) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const togglePage = () => setSelected(allOnPage ? new Set() : new Set(ids));

  const [bulk, bulking] = useAction(async (body, okText) => {
    try {
      await api.post('/admin/missed-orders/bulk', { ids: [...selected], ...body });
      toast.success(okText);
      setSelected(new Set());
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  });
  const [patch] = useAction(async (id, body) => {
    try {
      await api.patch(`/admin/missed-orders/${id}`, body);
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  });
  const perms = usePermissions();
  const canExport = perms.field('export') && perms.field('customerPhone');
  const canEdit = perms.can('missedOrders', 'edit');
  // The file is built on the server (export + phone grants) from the same filters as the list.
  const [exportFile, exporting] = useAction(async () => {
    try {
      await downloadFile('/admin/missed-orders/export', {
        query: { status: filters.status, priority: filters.priority, reason: filters.reason, test: filters.test, q: filters.q },
        filename: 'missed-orders.csv',
      });
    } catch (err) {
      toast.error(err.message);
    }
  });
  const editNote = (item) => {
    const note = window.prompt('ملاحظة عن هذا العميل', item.note || '');
    if (note !== null) patch(item._id, { note });
  };

  const counts = data?.counts || {};
  const pc = data?.priorityCounts || {};
  return (
    <>
      <PageHeader
        title="الطلبات المفقودة"
        subtitle="عملاء ضغطوا «إتمام الطلب» وحصلت لهم مشكلة. EasyOrders لا يرسلها تلقائيًا، فتُستورد من ملف التصدير (اسحب الملف وأفلته في أي مكان بالصفحة)."
        actions={
          <>
            {canExport && <Button variant="secondary" loading={exporting} onClick={exportFile}>تصدير إلى إكسل</Button>}
            {canEdit && <Button onClick={() => setImportOpen(true)}>استيراد ملف التصدير</Button>}
          </>
        }
      />
      {importOpen && <ImportModal key={prefill?.key || 'manual'} open prefill={prefill} onClose={() => { setImportOpen(false); setPrefill(null); }} onDone={() => reload({ silent: true })} />}

      <div className="tabs" role="tablist">
        {[
          ['open', `لم يُتواصل معهم${counts.open !== undefined ? ` · ${counts.open}` : ''}`],
          ['contacted', `تم التواصل${counts.contacted !== undefined ? ` · ${counts.contacted}` : ''}`],
          ['dismissed', `تم تجاهلهم${counts.dismissed !== undefined ? ` · ${counts.dismissed}` : ''}`],
          ['all', 'الكل'],
        ].map(([v, text]) => (
          <Button key={v} variant={status === v ? 'primary' : 'secondary'} onClick={() => update('status', v === 'open' ? '' : v)}>
            {text}
          </Button>
        ))}
      </div>

      <Card>
        <div className="filters">
          <input className="input filters__search" type="search" placeholder="بحث بالاسم أو الهاتف" aria-label="بحث" value={search} onChange={(e) => { setSearch(e.target.value); update('q', e.target.value); }} />
          <select className="input" aria-label="الأهمية" value={filters.priority} onChange={(e) => update('priority', e.target.value)}>
            <option value="">كل الأهميات</option>
            {Object.entries(PRIORITY).map(([v, p]) => (
              <option key={v} value={v}>{p.text}{pc[v] !== undefined ? ` (${pc[v]})` : ''}</option>
            ))}
          </select>
          <select className="input" aria-label="السبب" value={filters.reason} onChange={(e) => update('reason', e.target.value)}>
            <option value="">كل الأسباب</option>
            {data?.reasons?.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <select className="input" aria-label="التجريبية" value={filters.test} onChange={(e) => update('test', e.target.value)}>
            <option value="">بدون التجريبية</option>
            <option value="include">مع التجريبية</option>
            <option value="only">التجريبية فقط</option>
          </select>
        </div>
      </Card>

      {canEdit && selected.size > 0 && (
        <div className="alert alert--info row-between" role="region" aria-label="إجراءات جماعية">
          <span><strong>{selected.size}</strong> محدد</span>
          <span className="page-header__actions">
            <Button size="sm" variant="secondary" loading={bulking} onClick={() => bulk({ contacted: true }, 'تم تعليمهم كمتواصَل معهم')}>تم التواصل</Button>
            <Button size="sm" variant="secondary" loading={bulking} onClick={() => bulk({ dismissed: true }, 'تم تجاهلهم')}>تجاهل</Button>
            {filters.test === 'only' ? (
              <Button size="sm" variant="secondary" loading={bulking} onClick={() => bulk({ isTest: false }, 'تمت إعادتهم من التجريبية')}>إعادة من التجريبية</Button>
            ) : (
              <Button size="sm" variant="secondary" loading={bulking} onClick={() => bulk({ isTest: true }, 'تم نقلهم إلى التجريبية')}>نقل إلى التجريبية</Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>إلغاء التحديد</Button>
          </span>
        </div>
      )}

      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد طلبات مفقودة هنا" description="استورد ملف التصدير من EasyOrders، أو غيّر الفلاتر." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="تحديد الكل" checked={allOnPage} onChange={togglePage} /></th>
                  <th>العميل</th>
                  <th>السبب</th>
                  <th>تاريخ المحاولة</th>
                  <th>الأهمية</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => {
                  const p = PRIORITY[i.priority];
                  const wa = i.priority !== 'unreachable' && (i.phoneNormalized || i.phone) ? whatsappLink(i.phoneNormalized || i.phone, missedMessage(i.name)) : '';
                  return (
                    <tr key={i._id} className={selected.has(i._id) ? 'is-selected' : ''}>
                      <td><input type="checkbox" aria-label={`تحديد ${i.name}`} checked={selected.has(i._id)} onChange={() => toggle(i._id)} /></td>
                      <td>
                        <div>{i.name || '—'}</div>
                        <div className="muted mono" dir="ltr">{i.phone || '—'}</div>
                        {i.note && <div className="muted">📝 {i.note}</div>}
                      </td>
                      <td>
                        <div>{i.reasonLabel}</div>
                        {i.eoStatus && <div className="muted">{i.eoStatus}</div>}
                      </td>
                      <td className="nowrap muted">{formatDateTime(i.eoDate)}</td>
                      <td>
                        <Badge tone={p.tone}>{p.text}</Badge>
                        {i.orderedLater && (
                          <div className="muted">
                            {i.orderedLater.shortId ? <>طلب #{i.orderedLater.shortId}</> : 'له طلب لاحق'}
                          </div>
                        )}
                        {i.contactedAt && <div className="muted">تواصل: {i.contactedBy?.name || '—'}</div>}
                      </td>
                      <td>
                        <span className="page-header__actions">
                          {wa && (
                            <a className="btn btn--secondary btn--sm" href={wa} target="_blank" rel="noopener noreferrer" onClick={() => { logWhatsAppClick({ kind: 'missed', id: i._id, text: missedMessage(i.name) }); if (!i.contactedAt) patch(i._id, { contacted: true }); }}>
                              واتساب
                            </a>
                          )}
                          {canEdit && (
                            <>
                              <Button size="sm" variant="secondary" onClick={() => patch(i._id, { contacted: !i.contactedAt })}>
                                {i.contactedAt ? 'إلغاء التواصل' : 'تم التواصل'}
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => editNote(i)}>ملاحظة</Button>
                              <Button size="sm" variant="secondary" onClick={() => patch(i._id, { dismissed: !i.dismissedAt })}>
                                {i.dismissedAt ? 'استرجاع' : 'تجاهل'}
                              </Button>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => update('page', String(p))} />
      </Card>
      <p className="muted">
        تفاصيل الطلبات الفعلية في <Link className="link" to="/admin/orders">صفحة الطلبات</Link>. «غالبًا تجربة» تعني أن الرقم يخص طلبًا موسومًا تجريبيًا، أو الاسم يحمل «test/تجربة»، أو تكرر فشله ٣ مرات فأكثر.
      </p>
    </>
  );
}
