export const CSV_COLUMNS = [
  'path',
  'camera',
  'wall_clock',
  'time_source',
  'event_id',
  'independent',
  'detection_index',
  'detector_label',
  'detector_conf',
  'bbox_x',
  'bbox_y',
  'bbox_w',
  'bbox_h',
  'label_uuid',
  'common_name',
  'scientific_name',
  'score',
  'source',
  'corrected_common_name',
  'machine_label',
  'machine_score',
  'machine_source',
] as const;

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null>;

const NEEDS_QUOTES = /[",\r\n]/;

/** Prevents spreadsheet formulas while preserving numeric cells and RFC 4180 quoting. */
export function csvField(value: CsvRow[keyof CsvRow]): string {
  if (value === null) return '';
  const text =
    typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(value)
      ? `'${value}`
      : String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 quoting keeps commas, quotes and newlines inside one spreadsheet cell. */
export function toCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvField(row[column])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
