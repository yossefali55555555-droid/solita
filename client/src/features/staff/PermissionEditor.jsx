/**
 * Permission matrix editor (phase 4): a level per section, the dangerous
 * grants, and the field grants. It only builds the object that is sent to the
 * server; the server checks every rule again (a dangerous grant needs "edit"
 * on its section, unknown keys are refused).
 *
 * value = { sections: { orders: 'edit' }, dangerous: ['clearOrders'], fields: ['customerPhone'] }
 */
export const EMPTY_PERMISSIONS = { sections: {}, dangerous: [], fields: [] };

export function PermissionEditor({ catalog, value, onChange, disabled = false, fieldNote }) {
  if (!catalog) return null;
  const setLevel = (section, level) => {
    const sections = { ...value.sections };
    if (level === 'none') delete sections[section];
    else sections[section] = level;
    // A dangerous grant is only valid together with "edit" on its section.
    const dangerous = value.dangerous.filter((key) => {
      const def = catalog.dangerous.find((d) => d.key === key);
      return def?.section !== section || level === 'edit';
    });
    onChange({ ...value, sections, dangerous });
  };
  const toggle = (list, key) => (value[list].includes(key) ? value[list].filter((k) => k !== key) : [...value[list], key]);

  return (
    <div className="perm-editor">
      <div className="table-wrap">
        <table className="table perm-table">
          <thead>
            <tr>
              <th>القسم</th>
              <th>المستوى</th>
              <th>إجراءات خطرة</th>
            </tr>
          </thead>
          <tbody>
            {catalog.sections.map((section) => {
              const level = value.sections[section.key] || 'none';
              const dangers = catalog.dangerous.filter((d) => d.section === section.key);
              return (
                <tr key={section.key}>
                  <td>
                    {section.label}
                    {section.lockedByDefault && <span className="muted" title="مقفول افتراضيًا"> 🔒</span>}
                  </td>
                  <td>
                    <select
                      className="input"
                      aria-label={`مستوى ${section.label}`}
                      value={level}
                      disabled={disabled}
                      onChange={(e) => setLevel(section.key, e.target.value)}
                    >
                      <option value="none">بدون</option>
                      <option value="view">مشاهدة</option>
                      <option value="edit">تعديل</option>
                    </select>
                  </td>
                  <td>
                    {dangers.length === 0 && <span className="muted">—</span>}
                    {dangers.map((d) => (
                      <label key={d.key} className="checkbox">
                        <input
                          type="checkbox"
                          checked={value.dangerous.includes(d.key)}
                          disabled={disabled || level !== 'edit'}
                          onChange={() => onChange({ ...value, dangerous: toggle('dangerous', d.key) })}
                        />
                        <span>{d.label}</span>
                      </label>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <fieldset className="checklist">
        <legend>تصاريح الحقول</legend>
        {catalog.fields.map((f) => (
          <label key={f.key} className="checkbox">
            <input type="checkbox" checked={value.fields.includes(f.key)} disabled={disabled} onChange={() => onChange({ ...value, fields: toggle('fields', f.key) })} />
            <span>{f.label}</span>
          </label>
        ))}
        {fieldNote && <p className="muted">{fieldNote}</p>}
      </fieldset>
    </div>
  );
}

/** Words for the permission set (a short summary line under an account or a template). */
export function summarizePermissions(catalog, p) {
  if (!catalog) return '';
  const view = catalog.sections.filter((s) => p.sections?.[s.key] === 'view').map((s) => s.label);
  const edit = catalog.sections.filter((s) => p.sections?.[s.key] === 'edit').map((s) => s.label);
  const parts = [];
  if (edit.length) parts.push(`تعديل: ${edit.join('، ')}`);
  if (view.length) parts.push(`مشاهدة: ${view.join('، ')}`);
  return parts.join(' — ') || 'بلا صلاحيات';
}
