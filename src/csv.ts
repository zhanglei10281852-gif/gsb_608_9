export interface CsvRow {
  [key: string]: string;
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
}

export function parseCsv(input: string): CsvTable {
  const rawRows: string[][] = [];
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        current += ch;
        i++;
        continue;
      }
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      fields.push(current);
      current = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      if (i + 1 < input.length && input[i + 1] === "\n") {
        i++;
      }
      fields.push(current);
      current = "";
      rawRows.push(fields.splice(0));
      i++;
      continue;
    }

    if (ch === "\n") {
      fields.push(current);
      current = "";
      rawRows.push(fields.splice(0));
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (
    current !== "" ||
    fields.length > 0 ||
    (input.length > 0 && input[input.length - 1] === ",")
  ) {
    fields.push(current);
    rawRows.push(fields.splice(0));
  }

  if (rawRows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers: string[] = rawRows[0].map((h: string) => h.trim());
  const dataRows: CsvRow[] = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row: string[] = rawRows[r];
    if (row.length === 1 && row[0] === "" && r === rawRows.length - 1) {
      continue;
    }
    const obj: CsvRow = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = c < row.length ? row[c] : "";
    }
    dataRows.push(obj);
  }

  return { headers, rows: dataRows };
}

export function toCsv(headers: string[], rows: CsvRow[]): string {
  const lines: string[] = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function escapeField(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function toJson(headers: string[], rows: CsvRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function toTable(headers: string[], rows: CsvRow[]): string {
  const colWidths: number[] = headers.map((h) => {
    let max = h.length;
    for (const row of rows) {
      const len = (row[h] ?? "").length;
      if (len > max) max = len;
    }
    return max;
  });

  const pad = (s: string, w: number) => s.padEnd(w, " ");

  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join(" | ");
  const sepLine = colWidths.map((w) => "-".repeat(w)).join("-+-");

  const lines: string[] = [headerLine, sepLine];
  for (const row of rows) {
    lines.push(
      headers.map((h, i) => pad(row[h] ?? "", colWidths[i])).join(" | "),
    );
  }

  return lines.join("\n");
}
