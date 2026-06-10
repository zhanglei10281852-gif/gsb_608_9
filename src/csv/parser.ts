import { TableData, Row } from '../sql/ast';

export function parseCSV(content: string): TableData {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
          i += 2;
          continue;
        }
      } else if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
    i++;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], columnTypes: new Map() };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1).filter(row => row.length > 1 || (row.length === 1 && row[0] !== ''));

  const columnTypes = detectColumnTypes(headers, dataRows);

  const typedRows: Row[] = dataRows.map(row => {
    const obj: Row = {};
    headers.forEach((header, idx) => {
      const value = row[idx] ?? '';
      if (columnTypes.get(header) === 'number') {
        const num = parseFloat(value);
        obj[header] = isNaN(num) ? value : num;
      } else {
        obj[header] = value;
      }
    });
    return obj;
  });

  return { headers, rows: typedRows, columnTypes };
}

function detectColumnTypes(headers: string[], rows: string[][]): Map<string, 'string' | 'number'> {
  const types = new Map<string, 'string' | 'number'>();
  const sampleSize = Math.min(rows.length, 20);

  headers.forEach((header, idx) => {
    let allNumeric = true;
    for (let i = 0; i < sampleSize; i++) {
      const value = rows[i]?.[idx] ?? '';
      if (value === '') continue;
      if (isNaN(Number(value))) {
        allNumeric = false;
        break;
      }
    }
    types.set(header, allNumeric ? 'number' : 'string');
  });

  return types;
}

export function formatCSV(headers: string[], rows: Row[]): string {
  const lines: string[] = [];
  lines.push(headers.map(h => escapeCSVField(h)).join(','));

  for (const row of rows) {
    const line = headers.map(h => {
      const value = row[h];
      return escapeCSVField(value?.toString() ?? '');
    }).join(',');
    lines.push(line);
  }

  return lines.join('\n');
}

function escapeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}
