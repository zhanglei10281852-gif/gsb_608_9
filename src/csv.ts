export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string | number>[];
}

export function parseCSV(text: string): ParsedCSV {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
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
        i++;
        continue;
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
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = rows[0].map(h => h.trim());
  const dataRows: Record<string, string | number>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    const obj: Record<string, string | number> = {};
    for (let c = 0; c < headers.length; c++) {
      const value = row[c] !== undefined ? row[c].trim() : '';
      const num = Number(value);
      if (!isNaN(num) && value !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        obj[headers[c]] = num;
      } else {
        obj[headers[c]] = value;
      }
    }
    dataRows.push(obj);
  }

  return { headers, rows: dataRows };
}

export function stringifyCSV(data: Record<string, any>[], headers?: string[]): string {
  if (data.length === 0 && !headers) return '';
  
  const cols = headers || Object.keys(data[0] || {});
  const lines: string[] = [];
  
  lines.push(cols.map(escapeCSVField).join(','));
  
  for (const row of data) {
    lines.push(cols.map(col => {
      const val = row[col];
      return escapeCSVField(val === null || val === undefined ? '' : String(val));
    }).join(','));
  }
  
  return lines.join('\n');
}

function escapeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}
