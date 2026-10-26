import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import logoUrl from '../assets/solita-logo.svg';
import { Spinner } from './States.jsx';

/** Official Solita logo, used unchanged (colors and proportions preserved). */
export function Logo({ size = 48, className = '' }) {
  return (
    <img
      src={logoUrl}
      alt="Solita"
      width={size}
      height={size}
      className={`logo ${className}`}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}

export function Button({ variant = 'primary', size, loading = false, disabled, children, className = '', type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} ${size ? `btn--${size}` : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner label="جاري التنفيذ" />}
      <span>{children}</span>
    </button>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className = '', padded = true }) {
  return (
    <section className={`card ${padded ? 'card--padded' : ''} ${className}`}>
      {(title || actions) && (
        <header className="card__header">
          {title && <h2 className="card__title">{title}</h2>}
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }) {
  return (
    <div className="page-header">
      <div>
        {back && (
          <Link to={back} className="page-header__back">
            → رجوع
          </Link>
        )}
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, tone = 'neutral', to, hint }) {
  const content = (
    <>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </>
  );
  return to ? (
    <Link to={to} className={`stat stat--${tone} stat--link`}>
      {content}
    </Link>
  ) : (
    <div className={`stat stat--${tone}`}>{content}</div>
  );
}

export function Field({ label, error, hint, children, required }) {
  const id = useId();
  const child = typeof children === 'function' ? children(id) : children;
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      {label && (
        <label className="field__label" htmlFor={id}>
          {label}
          {required && <span className="field__required" aria-hidden="true"> *</span>}
        </label>
      )}
      {child}
      {hint && !error && <p className="field__hint">{hint}</p>}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DefinitionList({ items }) {
  return (
    <dl className="dl">
      {items
        .filter(Boolean)
        .map(([term, value]) => (
          <div className="dl__row" key={term}>
            <dt>{term}</dt>
            <dd>{value ?? '—'}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Accessible modal dialog with focus management and Escape to close. */
export function Modal({ open, title, onClose, children, footer, size = 'md' }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const node = ref.current;
    const focusable = node?.querySelector('input, select, textarea, button:not(.modal__close)');
    (focusable || node)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'تأكيد', tone = 'primary', loading, onConfirm, onClose, children }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            إلغاء
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="confirm__message">{message}</p>}
      {children}
    </Modal>
  );
}

export function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null;
  const { page, pages, total } = pagination;
  return (
    <nav className="pagination" aria-label="التنقل بين الصفحات">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        السابق
      </Button>
      <span className="pagination__info">
        صفحة {page} من {pages} ({total} نتيجة)
      </span>
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        التالي
      </Button>
    </nav>
  );
}

export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      وضع تجريبي: جميع البيانات المعروضة وهمية ومخزنة مؤقتاً فقط، ولا ترتبط بقاعدة البيانات الحقيقية أو EasyOrders.
    </div>
  );
}
