import { createPortal } from 'react-dom';
import logoUrl from '../../assets/solita-logo.svg';
import { formatDateTime, formatMoney } from '../../utils/format.js';
import { QrSvg } from './QrSvg.jsx';
import { SUPPORT_PHONES, labelPages, parcelsWord } from './labelUtils.js';

function Label({ label, parcel }) {
  return (
    <div className="lab">
      <div className="lab__head">
        <img src={logoUrl} alt="Solita" className="lab__logo" />
        <div className="lab__support">
          <span>خدمة العملاء</span>
          {SUPPORT_PHONES.map((p) => (
            <span key={p} dir="ltr">{p}</span>
          ))}
        </div>
      </div>

      <div className="lab__order">
        <div>
          <span className="lab__caption">رقم الطلب</span>
          <span className="lab__number" dir="ltr">{label.number}</span>
        </div>
        <div className="lab__parcel">
          <span>الطرد</span>
          <strong>{parcel.n} من {label.total}</strong>
        </div>
      </div>

      <div className="lab__customer">
        <div><span className="lab__caption">اسم العميل</span> <strong>{label.customer || '—'}</strong></div>
        <div><span className="lab__caption">الهاتف</span> <strong dir="ltr">{label.phone || '—'}</strong></div>
        {label.altPhone && <div><span className="lab__caption">هاتف بديل</span> <strong dir="ltr">{label.altPhone}</strong></div>}
      </div>

      <div className="lab__address">
        <strong>{label.city}{label.area ? ` — ${label.area}` : ''}</strong>
        <div className="lab__address-line">العنوان: {label.address || '—'}</div>
      </div>

      <div className="lab__content">محتوى الطرد: {parcel.content || '—'}</div>

      <div className="lab__pay">
        <div className="lab__amount">
          <span className="lab__caption">المبلغ المطلوب تحصيله</span>
          <span className="lab__money">{formatMoney(label.amount)}</span>
          <span className="lab__strip">
            {label.prepaid
              ? 'مدفوع مسبقًا — لا يُحصّل شيء'
              : `إجمالي الطلب (${parcelsWord(label.total)}) — يُحصّل مرة واحدة فقط`}
          </span>
        </div>
        <div className="lab__qr">
          <QrSvg text={parcel.code} />
          <span dir="ltr">{parcel.code}</span>
        </div>
      </div>

      <div className="lab__note">ملاحظات: {label.note || '—'}</div>

      <div className="lab__foot">
        <span>تاريخ الطباعة: {formatDateTime(label.printedAt)}</span>
        <span>شكرًا لاختياركم سوليتا</span>
      </div>
    </div>
  );
}

export function LabelSheets({ labels }) {
  const pages = labelPages(labels);
  return (
    <div className="label-sheets">
      {pages.map((page, i) => (
        <div className="sheet" key={i}>
          {page.map(({ label, parcel }) => (
            <div className="sheet__cell" key={parcel.code}>
              <Label label={label} parcel={parcel} />
            </div>
          ))}
          {Array.from({ length: 4 - page.length }, (_, k) => (
            <div className="sheet__cell sheet__cell--empty" key={`e${k}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Rendered outside the app root so that only the sheets are printed. */
export function PrintPortal({ labels }) {
  if (!labels?.length) return null;
  return createPortal(
    <div className="print-root">
      <LabelSheets labels={labels} />
    </div>,
    document.body,
  );
}
