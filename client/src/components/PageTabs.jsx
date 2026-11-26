import { useSearchParams } from 'react-router-dom';

/**
 * Tabs inside a page; they can be nested (give each level its own `param`).
 * The open tab lives in the address, so it can be linked to and survives a reload.
 * Every panel stays mounted, so half-typed forms are not lost when switching.
 */
export function PageTabs({ tabs, label, param = 'tab', level = 1, initial }) {
  const [params, setParams] = useSearchParams();
  const list = tabs.filter(Boolean);
  const wanted = params.get(param);
  const has = (key) => list.some((t) => t.key === key);
  const active = has(wanted) ? wanted : has(initial) ? initial : list[0]?.key;

  const open = (key) => {
    const next = new URLSearchParams(params);
    next.set(param, key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className={`ptabs ptabs--${level}`} role="tablist" aria-label={label}>
        {list.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === active}
            className={`ptabs__btn ${t.key === active ? 'is-active' : ''}`}
            onClick={() => open(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className="nav-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {list.map((t) => (
        <div key={t.key} role="tabpanel" aria-label={typeof t.label === 'string' ? t.label : undefined} hidden={t.key !== active}>
          {t.content}
        </div>
      ))}
    </>
  );
}
