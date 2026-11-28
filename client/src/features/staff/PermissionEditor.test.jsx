import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionEditor, summarizePermissions } from './PermissionEditor.jsx';

const catalog = {
  sections: [
    { key: 'orders', label: 'الطلبات' },
    { key: 'cash', label: 'الخزنة', lockedByDefault: true },
  ],
  dangerous: [{ key: 'clearOrders', label: 'مسح الطلبات', section: 'orders' }],
  fields: [{ key: 'customerPhone', label: 'رؤية رقم العميل', temporary: true }],
};

afterEach(cleanup);

describe('permission editor', () => {
  it('a dangerous grant needs "edit": lowering the level removes it, and its box is disabled', () => {
    const onChange = vi.fn();
    const value = { sections: { orders: 'edit' }, dangerous: ['clearOrders'], fields: [] };
    render(<PermissionEditor catalog={catalog} value={value} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('مستوى الطلبات'), { target: { value: 'view' } });
    expect(onChange).toHaveBeenCalledWith({ sections: { orders: 'view' }, dangerous: [], fields: [] });
  });

  it('shows the dangerous box disabled below edit, marks locked sections, and toggles field grants', () => {
    const onChange = vi.fn();
    render(<PermissionEditor catalog={catalog} value={{ sections: { orders: 'view' }, dangerous: [], fields: [] }} onChange={onChange} />);
    expect(screen.getByLabelText('مسح الطلبات')).toBeDisabled();
    expect(screen.getByText(/الخزنة/).textContent).toContain('🔒');
    fireEvent.click(screen.getByLabelText('رؤية رقم العميل'));
    expect(onChange).toHaveBeenCalledWith({ sections: { orders: 'view' }, dangerous: [], fields: ['customerPhone'] });
  });

  it('summarizes a set in words', () => {
    expect(summarizePermissions(catalog, { sections: { orders: 'edit', cash: 'view' } })).toBe('تعديل: الطلبات — مشاهدة: الخزنة');
    expect(summarizePermissions(catalog, { sections: {} })).toBe('بلا صلاحيات');
  });
});
