import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MetaExportModal } from './MetaExportModal.jsx';

const downloadFile = vi.fn(() => Promise.resolve());
vi.mock('../../services/api.js', () => ({ downloadFile: (...a) => downloadFile(...a) }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

describe('Meta export dialog', () => {
  beforeEach(() => downloadFile.mockClear());
  afterEach(cleanup);

  it('asks the server for the customer-list file with the chosen filters', async () => {
    const onClose = vi.fn();
    render(<MetaExportModal open onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('أقل عدد طلبات مُسلَّمة للعميل'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText(/إضافة العملاء أصحاب المرتجعات/));
    fireEvent.change(screen.getByLabelText('تجزئة البيانات'), { target: { value: 'sha256' } });
    fireEvent.click(screen.getByText('تنزيل الملف'));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    const [path, { query, filename }] = downloadFile.mock.calls[0];
    expect(path).toBe('/admin/customers/export-meta');
    expect(query).toMatchObject({ mode: 'customers', minOrders: 2, includeReturned: 'true', hash: 'sha256' });
    expect(filename).toBe('meta-customers.csv');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('the purchases file has no customer-only options', async () => {
    render(<MetaExportModal open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('نوع الملف'), { target: { value: 'orders' } });
    expect(screen.queryByLabelText('أقل عدد طلبات مُسلَّمة للعميل')).toBeNull();
    fireEvent.click(screen.getByText('تنزيل الملف'));
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    const { query, filename } = downloadFile.mock.calls[0][1];
    expect(query).toMatchObject({ mode: 'orders', minOrders: undefined, includeReturned: undefined });
    expect(filename).toBe('meta-orders.csv');
  });
});
