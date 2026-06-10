import { Expr, SelectStatement, SelectColumn, OrderByItem } from "./parser";
import { CsvRow, CsvTable, parseCsv } from "./csv";
import * as fs from "fs";

type CellValue = string | number;

interface RowCtx {
  [col: string]: CellValue;
}

export function execute(
  stmt: SelectStatement,
  tables: Record<string, CsvTable>,
): { headers: string[]; rows: CsvRow[] } {
  const fromTable = tables[stmt.from];
  if (!fromTable) {
    throw new Error(
      `Table not found: '${stmt.from}'. Available tables: ${Object.keys(tables).join(", ")}`,
    );
  }

  let rows: RowCtx[] = fromTable.rows.map((r) =>
    coerceRow(r, fromTable.headers),
  );

  if (stmt.join) {
    const joinTable = tables[stmt.join.table];
    if (!joinTable) {
      throw new Error(
        `Join table not found: '${stmt.join.table}'. Available tables: ${Object.keys(tables).join(", ")}`,
      );
    }
    const joinRows = joinTable.rows.map((r) => coerceRow(r, joinTable.headers));
    rows = performJoin(
      rows,
      joinRows,
      stmt.from,
      stmt.fromAlias,
      stmt.join,
      fromTable.headers,
      joinTable.headers,
    );
  }

  if (stmt.where) {
    rows = rows.filter((row) => {
      const val = evalExpr(stmt.where!, row);
      return isTruthy(val);
    });
  }

  let resultHeaders: string[];
  let resultRows: RowCtx[];

  if (stmt.groupBy) {
    const groups = groupRows(rows, stmt.groupBy);
    resultRows = [];
    resultHeaders = resolveGroupHeaders(
      stmt.columns,
      stmt.groupBy,
      fromTable.headers,
      stmt,
    );

    for (const group of groups) {
      const row = evalGroupRow(stmt.columns, group, stmt);
      if (stmt.having) {
        const havingVal = evalGroupExpr(stmt.having, group, row);
        if (!isTruthy(havingVal)) continue;
      }
      resultRows.push(row);
    }
  } else if (hasAggregates(stmt.columns)) {
    const group: Group = { key: {}, rows };
    const row = evalGroupRow(stmt.columns, group, stmt);
    resultRows = [row];
    resultHeaders = resolveGroupHeaders(
      stmt.columns,
      [],
      fromTable.headers,
      stmt,
    );
  } else {
    if (stmt.orderBy) {
      rows = sortRows(rows, stmt.orderBy);
    }

    if (stmt.offset) {
      rows = rows.slice(stmt.offset);
    }

    if (stmt.limit !== undefined) {
      rows = rows.slice(0, stmt.limit);
    }

    resultHeaders = resolveHeaders(stmt.columns, fromTable.headers, stmt);
    resultRows = rows.map((row) =>
      projectRow(stmt.columns, row, fromTable.headers, stmt),
    );

    const csvRows: CsvRow[] = resultRows.map((row) => {
      const out: CsvRow = {};
      for (const h of resultHeaders) {
        const v = row[h];
        out[h] = v === null || v === undefined ? "" : String(v);
      }
      return out;
    });

    return { headers: resultHeaders, rows: csvRows };
  }

  if (stmt.orderBy) {
    resultRows = sortRows(resultRows, stmt.orderBy);
  }

  if (stmt.offset) {
    resultRows = resultRows.slice(stmt.offset);
  }

  if (stmt.limit !== undefined) {
    resultRows = resultRows.slice(0, stmt.limit);
  }

  const csvRows: CsvRow[] = resultRows.map((row) => {
    const out: CsvRow = {};
    for (const h of resultHeaders) {
      const v = row[h];
      out[h] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  });

  return { headers: resultHeaders, rows: csvRows };
}

function coerceRow(row: CsvRow, headers: string[]): RowCtx {
  const out: RowCtx = {};
  for (const h of headers) {
    out[h] = coerceValue(row[h] ?? "");
  }
  return out;
}

export function coerceValue(val: string): CellValue {
  if (val === "") return "";
  const num = Number(val);
  if (!isNaN(num) && val.trim() !== "") return num;
  return val;
}

function isTruthy(val: CellValue): boolean {
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") return val !== "" && val !== "false";
  return !!val;
}

interface Group {
  key: Record<string, CellValue>;
  rows: RowCtx[];
}

function groupRows(rows: RowCtx[], groupBy: Expr[]): Group[] {
  const map = new Map<string, Group>();
  for (const row of rows) {
    const keyParts: string[] = [];
    const keyObj: Record<string, CellValue> = {};
    for (const expr of groupBy) {
      const val = evalExpr(expr, row);
      const key = String(val);
      keyParts.push(key);
      if (expr.type === "column") {
        keyObj[expr.name] = val;
      }
    }
    const keyStr = keyParts.join("\x00");
    if (!map.has(keyStr)) {
      map.set(keyStr, { key: keyObj, rows: [] });
    }
    map.get(keyStr)!.rows.push(row);
  }
  return Array.from(map.values());
}

function performJoin(
  leftRows: RowCtx[],
  rightRows: RowCtx[],
  leftName: string,
  leftAlias: string | undefined,
  join: { table: string; alias?: string; on: Expr },
  leftHeaders: string[],
  rightHeaders: string[],
): RowCtx[] {
  const result: RowCtx[] = [];
  const leftPrefix = leftAlias || leftName;
  const rightPrefix = join.alias || join.table;

  for (const lr of leftRows) {
    for (const rr of rightRows) {
      const combined: RowCtx = {};

      for (const h of leftHeaders) {
        combined[`${leftPrefix}.${h}`] = lr[h];
        combined[h] = lr[h];
      }
      for (const h of rightHeaders) {
        combined[`${rightPrefix}.${h}`] = rr[h];
        if (!(h in combined)) {
          combined[h] = rr[h];
        } else {
          combined[`${rightPrefix}.${h}`] = rr[h];
        }
      }

      const val = evalExpr(join.on, combined);
      if (isTruthy(val)) {
        result.push(combined);
      }
    }
  }
  return result;
}

function evalExpr(expr: Expr, row: RowCtx): CellValue {
  switch (expr.type) {
    case "literal":
      return expr.value;

    case "column": {
      if (expr.table) {
        const qualified = `${expr.table}.${expr.name}`;
        if (qualified in row) return row[qualified];
      }
      if (expr.name in row) return row[expr.name];
      throw new Error(
        `Column not found: '${expr.table ? expr.table + "." : ""}${expr.name}'`,
      );
    }

    case "star":
      return "";

    case "binary": {
      if (expr.op === "AND") {
        const l = evalExpr(expr.left, row);
        if (!isTruthy(l)) return 0;
        const r = evalExpr(expr.right, row);
        return isTruthy(r) ? 1 : 0;
      }
      if (expr.op === "OR") {
        const l = evalExpr(expr.left, row);
        if (isTruthy(l)) return 1;
        const r = evalExpr(expr.right, row);
        return isTruthy(r) ? 1 : 0;
      }

      const left = evalExpr(expr.left, row);
      const right = evalExpr(expr.right, row);

      switch (expr.op) {
        case "=":
          return compareValues(left, right) === 0 ? 1 : 0;
        case "!=":
        case "<>":
          return compareValues(left, right) !== 0 ? 1 : 0;
        case "<":
          return compareValues(left, right) < 0 ? 1 : 0;
        case "<=":
          return compareValues(left, right) <= 0 ? 1 : 0;
        case ">":
          return compareValues(left, right) > 0 ? 1 : 0;
        case ">=":
          return compareValues(left, right) >= 0 ? 1 : 0;
        case "+": {
          const ln = toNumber(left);
          const rn = toNumber(right);
          return ln + rn;
        }
        case "-": {
          const ln = toNumber(left);
          const rn = toNumber(right);
          return ln - rn;
        }
        case "*": {
          const ln = toNumber(left);
          const rn = toNumber(right);
          return ln * rn;
        }
        case "/": {
          const ln = toNumber(left);
          const rn = toNumber(right);
          if (rn === 0) throw new Error("Division by zero");
          return ln / rn;
        }
        default:
          throw new Error(`Unknown operator: ${expr.op}`);
      }
    }

    case "unary": {
      if (expr.op === "NOT") {
        const val = evalExpr(expr.operand, row);
        return isTruthy(val) ? 0 : 1;
      }
      throw new Error(`Unknown unary operator: ${expr.op}`);
    }

    case "like": {
      const val = evalExpr(expr.expr, row);
      return matchLike(String(val), expr.pattern) ? 1 : 0;
    }

    case "aggregate":
      return evalAggregateInRow(expr, row);

    case "is_null": {
      const val = evalExpr(expr.expr, row);
      const isNull = val === "" || val === null || val === undefined;
      return expr.negated ? (isNull ? 0 : 1) : isNull ? 1 : 0;
    }

    default:
      throw new Error(`Unknown expression type`);
  }
}

function compareValues(a: CellValue, b: CellValue): number {
  const aIsNum = typeof a === "number";
  const bIsNum = typeof b === "number";

  if (aIsNum && bIsNum) {
    return (a as number) - (b as number);
  }

  if (aIsNum && !bIsNum) {
    const bNum = Number(b);
    if (!isNaN(bNum)) return (a as number) - bNum;
    return -1;
  }

  if (!aIsNum && bIsNum) {
    const aNum = Number(a);
    if (!isNaN(aNum)) return aNum - (b as number);
    return 1;
  }

  return String(a).localeCompare(String(b));
}

function toNumber(val: CellValue): number {
  if (typeof val === "number") return val;
  const n = Number(val);
  if (isNaN(n)) throw new Error(`Cannot convert '${val}' to number`);
  return n;
}

function matchLike(value: string, pattern: string): boolean {
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".") +
    "$";
  const regex = new RegExp(regexStr, "i");
  return regex.test(value);
}

function evalAggregateInRow(expr: Expr, _row: RowCtx): CellValue {
  throw new Error(
    `Aggregate function ${expr.type === "aggregate" ? expr.func : ""} cannot be evaluated outside GROUP BY context`,
  );
}

function evalAggregate(func: string, arg: Expr, group: Group): CellValue {
  const values: CellValue[] = [];
  for (const row of group.rows) {
    if (arg.type === "star") {
      values.push(1);
    } else {
      const val = evalExpr(arg, row);
      if (val !== "" && val !== null && val !== undefined) {
        values.push(val);
      }
    }
  }

  switch (func) {
    case "COUNT":
      if (arg.type === "star") return group.rows.length;
      return values.length;

    case "SUM": {
      if (values.length === 0) return 0;
      return values.reduce((acc: number, v) => acc + toNumber(v), 0);
    }

    case "AVG": {
      if (values.length === 0) return 0;
      const sum = values.reduce((acc: number, v) => acc + toNumber(v), 0);
      return sum / values.length;
    }

    case "MIN": {
      if (values.length === 0) return "";
      return values.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b));
    }

    case "MAX": {
      if (values.length === 0) return "";
      return values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b));
    }

    default:
      throw new Error(`Unknown aggregate function: ${func}`);
  }
}

function hasAggregates(columns: SelectColumn[]): boolean {
  return columns.some((col) => exprHasAggregate(col.expr));
}

function exprHasAggregate(expr: Expr): boolean {
  if (expr.type === "aggregate") return true;
  if (expr.type === "binary")
    return exprHasAggregate(expr.left) || exprHasAggregate(expr.right);
  if (expr.type === "unary") return exprHasAggregate(expr.operand);
  return false;
}

function evalGroupRow(
  columns: SelectColumn[],
  group: Group,
  stmt: SelectStatement,
): RowCtx {
  const row: RowCtx = {};

  if (stmt.groupBy) {
    for (const expr of stmt.groupBy) {
      if (expr.type === "column") {
        row[expr.name] = evalExpr(expr, group.rows[0]);
      }
    }
  }

  for (const col of columns) {
    const header = col.alias || exprToName(col.expr);
    row[header] = evalGroupExpr(col.expr, group, row);
  }

  return row;
}

function evalGroupExpr(
  expr: Expr,
  group: Group,
  currentRow: RowCtx,
): CellValue {
  if (expr.type === "aggregate") {
    return evalAggregate(expr.func, expr.arg, group);
  }

  if (expr.type === "column") {
    if (expr.name in currentRow) return currentRow[expr.name];
    return evalExpr(expr, group.rows[0]);
  }

  if (expr.type === "binary") {
    if (expr.op === "AND" || expr.op === "OR") {
      const left = evalGroupExpr(expr.left, group, currentRow);
      if (expr.op === "AND" && !isTruthy(left)) return 0;
      if (expr.op === "OR" && isTruthy(left)) return 1;
      const right = evalGroupExpr(expr.right, group, currentRow);
      return isTruthy(right) ? 1 : 0;
    }

    const left = evalGroupExpr(expr.left, group, currentRow);
    const right = evalGroupExpr(expr.right, group, currentRow);

    switch (expr.op) {
      case "=":
        return compareValues(left, right) === 0 ? 1 : 0;
      case "!=":
      case "<>":
        return compareValues(left, right) !== 0 ? 1 : 0;
      case "<":
        return compareValues(left, right) < 0 ? 1 : 0;
      case "<=":
        return compareValues(left, right) <= 0 ? 1 : 0;
      case ">":
        return compareValues(left, right) > 0 ? 1 : 0;
      case ">=":
        return compareValues(left, right) >= 0 ? 1 : 0;
      case "+":
        return toNumber(left) + toNumber(right);
      case "-":
        return toNumber(left) - toNumber(right);
      case "*":
        return toNumber(left) * toNumber(right);
      case "/":
        return toNumber(left) / toNumber(right);
      default:
        throw new Error(`Unknown operator in GROUP context: ${expr.op}`);
    }
  }

  if (expr.type === "unary" && expr.op === "NOT") {
    const val = evalGroupExpr(expr.operand, group, currentRow);
    return isTruthy(val) ? 0 : 1;
  }

  if (expr.type === "literal") return expr.value;

  return evalExpr(expr, group.rows[0]);
}

function resolveGroupHeaders(
  columns: SelectColumn[],
  _groupBy: Expr[],
  _tableHeaders: string[],
  _stmt: SelectStatement,
): string[] {
  return columns.map((col) => col.alias || exprToName(col.expr));
}

function resolveHeaders(
  columns: SelectColumn[],
  tableHeaders: string[],
  stmt: SelectStatement,
): string[] {
  const headers: string[] = [];
  for (const col of columns) {
    if (col.expr.type === "star" && !col.expr.table) {
      if (stmt.join) {
        const leftPrefix = stmt.fromAlias || stmt.from;
        const rightPrefix = stmt.join.alias || stmt.join.table;
        for (const h of tableHeaders) {
          headers.push(`${leftPrefix}.${h}`);
        }
      } else {
        headers.push(...tableHeaders);
      }
    } else if (col.expr.type === "star" && col.expr.table) {
      headers.push(col.expr.table + ".*");
    } else {
      headers.push(col.alias || exprToName(col.expr));
    }
  }
  return headers;
}

function projectRow(
  columns: SelectColumn[],
  row: RowCtx,
  tableHeaders: string[],
  stmt: SelectStatement,
): RowCtx {
  const out: RowCtx = {};

  for (const col of columns) {
    if (col.expr.type === "star" && !col.expr.table) {
      if (stmt.join) {
        const leftPrefix = stmt.fromAlias || stmt.from;
        const rightPrefix = stmt.join.alias || stmt.join.table;
        for (const h of tableHeaders) {
          out[`${leftPrefix}.${h}`] = row[`${leftPrefix}.${h}`] ?? row[h];
        }
      } else {
        for (const h of tableHeaders) {
          out[h] = row[h];
        }
      }
    } else if (col.expr.type === "star" && col.expr.table) {
      // handled by headers
    } else {
      const header = col.alias || exprToName(col.expr);
      out[header] = evalExpr(col.expr, row);
    }
  }

  return out;
}

function sortRows(rows: RowCtx[], orderBy: OrderByItem[]): RowCtx[] {
  return [...rows].sort((a, b) => {
    for (const item of orderBy) {
      const av = evalExpr(item.expr, a);
      const bv = evalExpr(item.expr, b);
      const cmp = compareValues(av, bv);
      if (cmp !== 0) {
        return item.direction === "DESC" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function exprToName(expr: Expr): string {
  switch (expr.type) {
    case "column":
      return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case "star":
      return expr.table ? `${expr.table}.*` : "*";
    case "literal":
      return String(expr.value);
    case "aggregate": {
      const argName = exprToName(expr.arg);
      return `${expr.func}(${argName})`;
    }
    case "binary":
      return `${exprToName(expr.left)} ${expr.op} ${exprToName(expr.right)}`;
    case "unary":
      return `${expr.op} ${exprToName(expr.operand)}`;
    case "like":
      return `${exprToName(expr.expr)} LIKE '${expr.pattern}'`;
    default:
      return "?";
  }
}

export function loadTableFromFile(filePath: string): CsvTable {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: '${filePath}'`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return parseCsv(content);
}

export function loadTableFromStdin(): Promise<CsvTable> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(parseCsv(data));
    });
    process.stdin.on("error", (err: Error) => {
      reject(err);
    });
  });
}
