// CSV parser and serializer (RFC 4180-ish)
// Supports:
// - quoted fields with embedded commas / newlines
// - escaped double quotes ("")
// - configurable line endings on output (uses \n)

export type Row = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: Row[];
}

/**
 * Parse a CSV string into headers + array of row objects.
 * The first non-empty row is treated as the header row.
 */
export function parseCsv(input: string): ParsedCsv {
  const records = parseCsvRecords(input);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = records[0];
  const rows: Row[] = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    // Skip completely empty trailing line
    if (rec.length === 1 && rec[0] === "") continue;
    const obj: Row = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = c < rec.length ? rec[c] : "";
    }
    rows.push(obj);
  }
  return { headers, rows };
}

/**
 * Lower-level: parse CSV text into a 2D array of strings.
 */
export function parseCsvRecords(input: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let i = 0;
  const len = input.length;
  let inQuotes = false;

  while (i < len) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && input[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += ch;
        i++;
        continue;
      }
    } else {
      if (ch === '"') {
        // Start of quoted section. If field already has content, we still treat
        // the quote literally only if it's not at the start; standard CSV
        // requires quote at field start. We follow the strict rule: only at start.
        if (field.length === 0) {
          inQuotes = true;
          i++;
          continue;
        } else {
          field += ch;
          i++;
          continue;
        }
      } else if (ch === ",") {
        record.push(field);
        field = "";
        i++;
        continue;
      } else if (ch === "\r") {
        // Handle \r\n or lone \r
        record.push(field);
        field = "";
        records.push(record);
        record = [];
        if (i + 1 < len && input[i + 1] === "\n") {
          i += 2;
        } else {
          i++;
        }
        continue;
      } else if (ch === "\n") {
        record.push(field);
        field = "";
        records.push(record);
        record = [];
        i++;
        continue;
      } else {
        field += ch;
        i++;
        continue;
      }
    }
  }

  // Flush last field/record
  if (inQuotes) {
    throw new Error("CSV parse error: unterminated quoted field");
  }
  // Always push the last field unless input was completely empty
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

/**
 * Serialize rows back into CSV.
 * `headers` controls column order. If a row is missing a header, empty string
 * is emitted.
 */
export function serializeCsv(headers: string[], rows: Row[]): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsvField).join(","));
  for (const row of rows) {
    const cols = headers.map((h) => escapeCsvField(row[h] ?? ""));
    lines.push(cols.join(","));
  }
  return lines.join("\n") + "\n";
}

function escapeCsvField(value: string): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
