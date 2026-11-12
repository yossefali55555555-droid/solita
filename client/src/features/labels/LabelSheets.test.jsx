import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelSheets } from './LabelSheets.jsx';
import { labelPages, parcelsWord } from './labelUtils.js';

const label = (number, count) => ({
  orderId: number,
  number,
  total: count,
  parcels: Array.from({ length: count }, (_, i) => ({ n: i + 1, code: `SOL:${number}-${i + 1}/${count}`, content: 'حذاء — مقاس 42' })),
  customer: 'عميل',
  phone: '01111111111',
  city: 'القاهرة',
  address: 'شارع',
  amount: 105000,
  prepaid: false,
  printedAt: '2026-11-12T10:00:00Z',
});

describe('labels', () => {
  it('uses the right Arabic word for the parcel count', () => {
    expect(parcelsWord(1)).toBe('طرد واحد');
    expect(parcelsWord(2)).toBe('طردان');
    expect(parcelsWord(5)).toBe('5 طرود');
    expect(parcelsWord(12)).toBe('12 طردًا');
  });

  it('puts four labels per sheet', () => {
    const pages = labelPages([label('24', 3), label('25', 2)]);
    expect(pages.map((p) => p.length)).toEqual([4, 1]);
  });

  it('draws one label per parcel with its QR text', () => {
    render(<LabelSheets labels={[label('24', 2)]} />);
    expect(screen.getByText('SOL:24-1/2')).toBeInTheDocument();
    expect(screen.getByText('SOL:24-2/2')).toBeInTheDocument();
    expect(screen.getAllByText(/إجمالي الطلب \(طردان\)/)).toHaveLength(2);
    expect(screen.getAllByRole('img', { name: /SOL:24/ })).toHaveLength(2);
  });
});
