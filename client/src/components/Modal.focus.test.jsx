import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Modal } from './ui.jsx';
import { useAsync } from '../hooks/useAsync.js';

// Typing re-renders the parent; the parent passes a NEW onClose function each time,
// exactly as the pages do (`onClose={() => setOpen(false)}`).
function Form() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <Modal open title="نموذج" onClose={() => setName('')}>
      <input aria-label="الاسم" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="الهاتف" value={phone} onChange={(e) => setPhone(e.target.value)} />
    </Modal>
  );
}

// One keystroke at a time, like a phone keyboard: each character is its own change event.
function type(el, text) {
  let value = '';
  for (const ch of text) {
    value += ch;
    fireEvent.change(el, { target: { value } });
  }
}

describe('keyboard stays open while typing', () => {
  it('a modal input keeps focus (and the first field does not steal it) when the parent re-renders', async () => {
    render(<Form />);
    const phone = screen.getByLabelText('الهاتف');
    phone.focus();
    type(phone, '0123');
    expect(phone).toHaveFocus();
    expect(phone).toHaveValue('0123');
  });

  it('a silent reload does not unmount an input that lives next to the data', async () => {
    let calls = 0;
    function Page() {
      const { data, loading, reload } = useAsync(async () => ({ n: ++calls }), []);
      const [q, setQ] = useState('');
      return (
        <div>
          <input aria-label="بحث" value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={() => reload({ silent: true })}>تحديث</button>
          {loading && !data ? <p>جاري التحميل</p> : <p>n={data?.n}</p>}
        </div>
      );
    }
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText('بحث');
    input.focus();
    type(input, 'ab');
    await act(async () => {
      fireEvent.click(screen.getByText('تحديث'));
    });
    type(input, 'abc');
    expect(input.isConnected).toBe(true);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('abc');
  });
});
