/**
 * Turn a dropped / chosen file into the plain text the import endpoint reads:
 * CSV / TSV / TXT are read as text; .xlsx is read with read-excel-file (first
 * sheet) and written out as tab-separated text. Dates become dd/mm/yyyy hh:mm,
 * the same format the EasyOrders dashboard shows.
 */

const DATE_HEADER = /تاريخ|date|created/i;
const pad = (n) => String(n).padStart(2, '0');

/** Excel stores wall-clock time with no zone; read-excel-file gives it as UTC, so read the UTC parts. */
export function formatSheetDate(d) {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** An Excel serial day number (e.g. 46330.4799) as a Date holding the same wall-clock time (UTC fields). */
export function serialToDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400) * 1000);
}

function cellText(value, isDateColumn) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatSheetDate(value);
  if (typeof value === 'number') {
    if (isDateColumn && value > 20000 && value < 90000) return formatSheetDate(serialToDate(value));
    return String(value);
  }
  return String(value).replace(/[\t\r\n]+/g, ' ').trim();
}

/** Rows (arrays of cell values) -> tab-separated text. The first row is the header. */
export function rowsToTsv(rows) {
  if (!rows?.length) return '';
  const dateCols = new Set((rows[0] || []).map((h, i) => (DATE_HEADER.test(String(h ?? '')) ? i : -1)).filter((i) => i >= 0));
  return rows.map((row, r) => row.map((v, i) => cellText(v, r > 0 && dateCols.has(i))).join('\t')).join('\n');
}

export const isXlsx = (file) => /\.xlsx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function fileToImportText(file) {
  if (/\.xls$/i.test(file.name)) throw new Error('صيغة xls القديمة غير مدعومة. احفظ الملف بصيغة xlsx أو csv.');
  if (isXlsx(file)) {
    const { readSheet } = await import('read-excel-file/browser');
    const rows = await readSheet(file);
    return rowsToTsv(rows);
  }
  return file.text();
}
