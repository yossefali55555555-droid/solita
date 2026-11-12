import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAction } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { QrScanner } from '../../features/labels/QrScanner.jsx';

const TONE = { ok: 'success', mine: 'info', block: 'danger' };

/** Courier pickup: scan every parcel of the orders assigned to you. */
export function CourierScanPage() {
  const [results, setResults] = useState([]);

  const [scan, scanning] = useAction(async (code) => {
    let result;
    try {
      result = await api.post('/courier/scan', { code });
    } catch (err) {
      result = { kind: 'block', message: err.message };
    }
    setResults((list) => [{ ...result, code, at: Date.now() }, ...list].slice(0, 30));
  });

  const latest = results[0];
  return (
    <div className="courier-scan">
      <h1 className="courier-scan__title">استلام الطرود</h1>
      <p className="muted">امسح QR كل طرد من طرود الطلب. لا يمكن بدء التوصيل قبل مسح كل الطرود.</p>
      <QrScanner onCode={scan} busy={scanning} />
      {latest && (
        <div className={`alert alert--${TONE[latest.kind] || 'info'} scan-result`} role="status">
          <strong>{latest.message}</strong>
          {latest.order && (
            <div className="small">
              طلب <span className="mono" dir="ltr">{latest.order.number}</span>
              {latest.order.customer ? ` — ${latest.order.customer}` : ''} · تم مسح {latest.order.parcels.pickedUp} من{' '}
              {latest.order.parcels.total}
              {' · '}
              <Link className="link" to={`/courier/orders/${latest.order._id}`}>فتح الطلب</Link>
            </div>
          )}
        </div>
      )}
      {results.length > 1 && (
        <ul className="simple-list scan-log">
          {results.slice(1).map((r) => (
            <li key={r.at} className={`scan-log__item scan-log__item--${r.kind}`}>
              <span className="mono" dir="ltr">{r.code}</span> — {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
