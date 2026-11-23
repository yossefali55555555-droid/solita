import { describe, expect, it } from 'vitest';
import { formatSheetDate, rowsToTsv, serialToDate } from './spreadsheet.js';

describe('spreadsheet import helpers', () => {
  it('writes Date cells and Excel serials in date columns as dd/mm/yyyy hh:mm', () => {
    const rows = [
      ['العميل', 'تاريخ الطلب'],
      ['أحمد 01012345678', new Date('2026-11-08T11:31:00.000Z')],
      ['منى 01234567890', 46323.53333333333],
    ];
    expect(rowsToTsv(rows)).toBe('العميل\tتاريخ الطلب\nأحمد 01012345678\t08/11/2026 11:31\nمنى 01234567890\t28/10/2026 12:48');
  });

  it('keeps phone-like numbers in other columns untouched and strips tabs and line breaks', () => {
    const rows = [['الهاتف', 'السبب'], [1097711577, 'خطأ\tفي\nالبيانات']];
    expect(rowsToTsv(rows)).toBe('الهاتف\tالسبب\n1097711577\tخطأ في البيانات');
  });

  it('converts serials back to the same wall-clock time', () => {
    expect(formatSheetDate(serialToDate(46330.4799))).toBe('04/11/2026 11:31');
  });
});
