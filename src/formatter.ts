import { QueryResult } from './executor';
import { stringifyCSV } from './csv';

export type OutputFormat = 'csv' | 'json' | 'table';

export function formatResult(result: QueryResult, format: OutputFormat): string {
  switch (format) {
    case 'csv':
      return formatCSV(result);
    case 'json':
      return formatJSON(result);
    case 'table':
      return formatTable(result);
  }
}

function formatCSV(result: QueryResult): string {
  return stringifyCSV(result.rows, result.headers);
}

function formatJSON(result: QueryResult): string {
  const obj = result.rows.map(row => {
    const o: Record<string, string | number> = {};
    for (const h of result.headers) {
      o[h] = row[h];
    }
    return o;
  });
  return JSON.stringify(obj, null, 2);
}

function formatTable(result: QueryResult): string {
  if (result.rows.length === 0) {
    if (result.headers.length === 0) return '(no rows)';
    const headerLine = result.headers.join(' | ');
    const sepLine = result.headers.map(h => '-'.repeat(h.length)).join('-|-');
    return headerLine + '\n' + sepLine + '\n(0 rows)';
  }

  const colWidths: number[] = result.headers.map(h => h.length);
  for (const row of result.rows) {
    for (let i = 0; i < result.headers.length; i++) {
      const val = String(row[result.headers[i]] ?? '');
      colWidths[i] = Math.max(colWidths[i], val.length);
    }
  }

  const lines: string[] = [];
  const header = result.headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ');
  lines.push(header);
  lines.push(colWidths.map(w => '-'.repeat(w)).join('-+-'));
  for (const row of result.rows) {
    const line = result.headers.map((h, i) => String(row[h] ?? '').padEnd(colWidths[i])).join(' | ');
    lines.push(line);
  }
  lines.push(`\n(${result.rows.length} row${result.rows.length === 1 ? '' : 's'})`);
  return lines.join('\n');
}
