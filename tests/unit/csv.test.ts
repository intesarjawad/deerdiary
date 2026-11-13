import { expect, test } from 'vitest';
import { CSV_COLUMNS, type CsvRow, toCsv } from '../../src/core/csv';

const BOM = '\uFEFF';
const HEADER =
  'path,camera,wall_clock,time_source,event_id,independent,detection_index,detector_label,detector_conf,bbox_x,bbox_y,bbox_w,bbox_h,label_uuid,common_name,scientific_name,score,source,corrected_common_name,machine_label,machine_score,machine_source';
const EMPTY_ROW = ',,,,,,,,,,,,,,,,,,,,,';

function row(overrides: Partial<CsvRow>): CsvRow {
  const empty = Object.fromEntries(CSV_COLUMNS.map((column) => [column, null])) as CsvRow;
  return { ...empty, ...overrides };
}

test('writes the BOM and the full header when there are no rows', () => {
  expect(toCsv([])).toBe(`${BOM}${HEADER}\r\n`);
});

test('writes the header line before the rows, in column order', () => {
  expect(toCsv([row({ path: 'a.jpg' })])).toBe(`${BOM}${HEADER}\r\na.jpg,,,,,,,,,,,,,,,,,,,,,\r\n`);
});

test('quotes a field containing a comma', () => {
  expect(toCsv([row({ path: 'a,b.jpg' })])).toBe(
    `${BOM}${HEADER}\r\n"a,b.jpg",,,,,,,,,,,,,,,,,,,,,\r\n`,
  );
});

test('doubles an embedded quote and wraps the field', () => {
  expect(toCsv([row({ path: 'a"b.jpg' })])).toBe(
    `${BOM}${HEADER}\r\n"a""b.jpg",,,,,,,,,,,,,,,,,,,,,\r\n`,
  );
});

test('quotes a field containing a newline', () => {
  expect(toCsv([row({ path: 'a\nb.jpg' })])).toBe(
    `${BOM}${HEADER}\r\n"a\nb.jpg",,,,,,,,,,,,,,,,,,,,,\r\n`,
  );
});

test('writes null as an empty field', () => {
  expect(toCsv([row({})])).toBe(`${BOM}${HEADER}\r\n${EMPTY_ROW}\r\n`);
});

test.each(['=1+1', '+cmd', '-cmd', '@SUM(1)', '\t=1', '\r=1', '\n=1', '  =1'])(
  'neutralizes spreadsheet text %j',
  (text) => {
    expect(toCsv([row({ common_name: text })])).toContain(`'${text}`);
  },
);

test('keeps negative numeric cells numeric', () => {
  expect(toCsv([row({ bbox_x: -0.5 })])).toContain(',-0.5,');
});
