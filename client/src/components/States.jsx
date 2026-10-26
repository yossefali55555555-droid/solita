export function Spinner({ label = 'جاري التحميل' }) {
  return <span className="spinner" role="progressbar" aria-label={label} />;
}

export function LoadingState({ full = false, label = 'جاري التحميل...' }) {
  return (
    <div className={`state ${full ? 'state--full' : ''}`}>
      <Spinner />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title = 'لا توجد بيانات', description, action }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {description && <p className="state__desc">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">تعذر تحميل البيانات</p>
      <p className="state__desc">{error?.message || 'حدث خطأ غير متوقع'}</p>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={() => onRetry()}>
          إعادة المحاولة
        </button>
      )}
    </div>
  );
}
