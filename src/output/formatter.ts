import { Row } from '../sql/ast';
import { formatCSV } from '../csv/parser';

export type OutputFormat = 'csv' | 'json' | 'table';

export function formatOutput(
  headers: string[],
  rows: Row[],
  format: OutputFormat
): string {
  switch (format) {
    case 'csv':
      return formatCSV(headers, rows);
    case 'json':
      return formatJSON(headers, rows);
    case 'table':
      return formatTable(headers, rows);
    default:
      throw new Error(`Unknown output format: ${format}`);
  }
}

function formatJSON(headers: string[], rows: Row[]): string {
  const jsonRows = rows.map(row => {
    const obj: Record<string, any> = {};
    for (const header of headers) {
      obj[header] = row[header];
    }
    return obj;
  });
  return JSON.stringify(jsonRows, null, 2);
}

function formatTable(headers: string[], rows: Row[]): string {
  const columnWidths = headers.map(header => header.length);

  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      const value = String(row[headers[i]] ?? '');
      if (value.length > columnWidths[i]) {
        columnWidths[i] = value.length;
      }
    }
  }

  const separator = '+' + columnWidths.map(w => '-'.repeat(w + 2)).join('+') + '+';

  const lines: string[] = [];
  lines.push(separator);
  lines.push('|' + headers.map((h, i) => ` ${h.padEnd(columnWidths[i])} `).join('|') + '|');
  lines.push(separator);

  for (const row of rows) {
    const line = '|' + headers.map((h, i) => {
      const value = String(row[h] ?? '');
      return ` ${value.padEnd(columnWidths[i])} `;
    }).join('|') + '|';
    lines.push(line);
  }

  lines.push(separator);

  return lines.join('\n');
}
