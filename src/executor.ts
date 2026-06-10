// Query executor: walks the AST and produces a result table.
//
// Data model:
// - A `Table` is the in-memory representation of a CSV source plus
//   per-column inferred type information.
// - During execution we work with "typed rows": each row is an array of
//   columns (alias.column -> value). Internally we store a flat record
//   keyed by "alias.col" for joined rows.
// - Values can be number, string, null or boolean.

import { parseCsv, ParsedCsv, Row, serializeCsv } from "./csv";
import {
  BinaryExpr,
  ColumnRef,
  Expr,
  IsNullExpr,
  JoinClause,
  OrderItem,
  SelectItem,
  SelectQuery,
  TableRef,
  UnaryExpr,
  FuncCall,
} from "./parser";

export type Value = number | string | boolean | null;

export interface Table {
  alias: string;
  headers: string[];
  // Inferred type per column: "number" if every non-empty cell parses as a
  // finite number, otherwise "string". Empty columns default to "string".
  colTypes: Record<string, "number" | "string">;
  rows: Row[];
}

export class ExecError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export interface ResultTable {
  headers: string[];
  rows: Record<string, Value>[];
}

// --- helpers ---

function inferTypes(parsed: ParsedCsv): Record<string, "number" | "string"> {
  const types: Record<string, "number" | "string"> = {};
  for (const h of parsed.headers) {
    let allNumeric = true;
    let sawAny = false;
    for (const r of parsed.rows) {
      const v = r[h];
      if (v === undefined || v === "") continue;
      sawAny = true;
      if (!isNumericString(v)) {
        allNumeric = false;
        break;
      }
    }
    types[h] = sawAny && allNumeric ? "number" : "string";
  }
  return types;
}

export function makeTable(alias: string, parsed: ParsedCsv): Table {
  return {
    alias,
    headers: parsed.headers,
    colTypes: inferTypes(parsed),
    rows: parsed.rows,
  };
}

export function loadTableFromCsv(alias: string, csvText: string): Table {
  return makeTable(alias, parseCsv(csvText));
}

function isNumericString(s: string): boolean {
  if (s === "" || s === null || s === undefined) return false;
  // Allow optional sign, digits, optional fractional, optional exponent.
  return /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s);
}

function toNumberMaybe(v: Value): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && isNumericString(v)) return Number(v);
  return null;
}

function isTruthy(v: Value): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return false;
}

// "joined row": map from "alias.column" -> string value (raw)
type JoinedRow = Record<string, string>;

interface ExecCtx {
  tables: Table[];
  // alias -> Table for fast lookup
  byAlias: Record<string, Table>;
  // For unqualified column resolution: list of (alias, header) pairs.
}

function buildCtx(tables: Table[]): ExecCtx {
  const byAlias: Record<string, Table> = {};
  for (const t of tables) byAlias[t.alias] = t;
  return { tables, byAlias };
}

function resolveColumn(
  ctx: ExecCtx,
  ref: ColumnRef,
): { alias: string; col: string; type: "number" | "string" } {
  if (ref.table) {
    const t = ctx.byAlias[ref.table];
    if (!t) throw new ExecError(`unknown table alias '${ref.table}'`);
    if (!(ref.name in t.colTypes)) {
      throw new ExecError(
        `column '${ref.name}' not found in table '${ref.table}'`,
      );
    }
    return { alias: ref.table, col: ref.name, type: t.colTypes[ref.name] };
  }
  // Unqualified - find matching alias
  const matches: { alias: string; type: "number" | "string" }[] = [];
  for (const t of ctx.tables) {
    if (ref.name in t.colTypes)
      matches.push({ alias: t.alias, type: t.colTypes[ref.name] });
  }
  if (matches.length === 0)
    throw new ExecError(`column '${ref.name}' not found`);
  if (matches.length > 1) {
    throw new ExecError(
      `column '${ref.name}' is ambiguous; qualify with table alias`,
    );
  }
  return { alias: matches[0].alias, col: ref.name, type: matches[0].type };
}

function getCellRaw(row: JoinedRow, alias: string, col: string): string {
  const key = alias + "." + col;
  return row[key] !== undefined ? row[key] : "";
}

function getCellTyped(ctx: ExecCtx, row: JoinedRow, ref: ColumnRef): Value {
  const r = resolveColumn(ctx, ref);
  const raw = getCellRaw(row, r.alias, r.col);
  if (raw === "") return null;
  if (r.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw; // fallback
  }
  return raw;
}

// LIKE pattern -> regex
function likeToRegex(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += escapeRegex(ch);
  }
  re += "$";
  return new RegExp(re);
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareValues(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  // Numeric vs numeric
  if (typeof a === "number" && typeof b === "number") {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  // Mixed: try numeric coercion if both convertible
  const an = toNumberMaybe(a);
  const bn = toNumberMaybe(b);
  if (
    an !== null &&
    bn !== null &&
    (typeof a !== "string" ||
      typeof b !== "string" ||
      (isNumericString(a) && isNumericString(b)))
  ) {
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }
  // String compare
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function valuesEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return false; // SQL: NULL = NULL is not true
  return compareValues(a, b) === 0;
}

// ---- expression eval ----

function evalExpr(
  ctx: ExecCtx,
  row: JoinedRow,
  e: Expr,
  agg?: AggContext,
): Value {
  switch (e.type) {
    case "number":
      return e.value;
    case "string":
      return e.value;
    case "null":
      return null;
    case "bool":
      return e.value;
    case "column":
      return getCellTyped(ctx, row, e);
    case "unary":
      return evalUnary(ctx, row, e, agg);
    case "binary":
      return evalBinary(ctx, row, e, agg);
    case "isnull": {
      const v = evalExpr(ctx, row, e.expr, agg);
      const isnull = v === null;
      return e.negate ? !isnull : isnull;
    }
    case "func":
      return evalFunc(ctx, row, e, agg);
  }
}

function evalUnary(
  ctx: ExecCtx,
  row: JoinedRow,
  e: UnaryExpr,
  agg?: AggContext,
): Value {
  const v = evalExpr(ctx, row, e.expr, agg);
  if (e.op === "NOT") {
    if (v === null) return null;
    return !isTruthy(v);
  }
  if (e.op === "-") {
    const n = toNumberMaybe(v);
    if (n === null)
      throw new ExecError(`cannot apply unary minus to non-numeric value`);
    return -n;
  }
  throw new ExecError(`unknown unary operator ${e.op}`);
}

function evalBinary(
  ctx: ExecCtx,
  row: JoinedRow,
  e: BinaryExpr,
  agg?: AggContext,
): Value {
  if (e.op === "AND") {
    const l = evalExpr(ctx, row, e.left, agg);
    if (l === null) {
      const r = evalExpr(ctx, row, e.right, agg);
      if (r !== null && !isTruthy(r)) return false;
      return null;
    }
    if (!isTruthy(l)) return false;
    const r = evalExpr(ctx, row, e.right, agg);
    if (r === null) return null;
    return isTruthy(r);
  }
  if (e.op === "OR") {
    const l = evalExpr(ctx, row, e.left, agg);
    if (l !== null && isTruthy(l)) return true;
    const r = evalExpr(ctx, row, e.right, agg);
    if (r !== null && isTruthy(r)) return true;
    if (l === null || r === null) return null;
    return false;
  }

  const l = evalExpr(ctx, row, e.left, agg);
  const r = evalExpr(ctx, row, e.right, agg);

  if (e.op === "LIKE") {
    if (l === null || r === null) return null;
    const re = likeToRegex(String(r));
    return re.test(String(l));
  }

  if (
    e.op === "=" ||
    e.op === "!=" ||
    e.op === "<" ||
    e.op === "<=" ||
    e.op === ">" ||
    e.op === ">="
  ) {
    if (l === null || r === null) return null;
    const cmp = compareValues(l, r);
    switch (e.op) {
      case "=":
        return cmp === 0;
      case "!=":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
    }
  }

  if (
    e.op === "+" ||
    e.op === "-" ||
    e.op === "*" ||
    e.op === "/" ||
    e.op === "%"
  ) {
    if (l === null || r === null) return null;
    const ln = toNumberMaybe(l);
    const rn = toNumberMaybe(r);
    if (ln === null || rn === null) {
      throw new ExecError(
        `arithmetic on non-numeric values: ${l} ${e.op} ${r}`,
      );
    }
    switch (e.op) {
      case "+":
        return ln + rn;
      case "-":
        return ln - rn;
      case "*":
        return ln * rn;
      case "/":
        if (rn === 0) throw new ExecError("division by zero");
        return ln / rn;
      case "%":
        if (rn === 0) throw new ExecError("modulo by zero");
        return ln % rn;
    }
  }

  throw new ExecError(`unknown binary operator ${e.op}`);
}

// ---- Aggregates ----

interface AggContext {
  // For each aggregate expression encountered (identified by id), the
  // pre-computed value for the current row's group.
  values: Map<string, Value>;
}

const AGG_FUNCS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

function evalFunc(
  ctx: ExecCtx,
  row: JoinedRow,
  e: FuncCall,
  agg?: AggContext,
): Value {
  if (AGG_FUNCS.has(e.name)) {
    if (!agg) {
      throw new ExecError(`aggregate ${e.name} not allowed here`);
    }
    const id = aggKey(e);
    if (!agg.values.has(id)) {
      throw new ExecError(`aggregate ${e.name} not computed for this row`);
    }
    return agg.values.get(id)!;
  }
  // No non-aggregate functions implemented for this minimal subset.
  throw new ExecError(`unknown function ${e.name}`);
}

function aggKey(e: FuncCall): string {
  return `${e.name}|${e.star ? "*" : exprKey(e.args[0])}`;
}

function exprKey(e: Expr): string {
  // Stable string for an expression - good enough for aggregate identity.
  return JSON.stringify(e);
}

function collectAggregates(e: Expr, out: FuncCall[]): void {
  switch (e.type) {
    case "func":
      if (AGG_FUNCS.has(e.name)) {
        out.push(e);
      }
      for (const a of e.args) collectAggregates(a, out);
      return;
    case "binary":
      collectAggregates(e.left, out);
      collectAggregates(e.right, out);
      return;
    case "unary":
      collectAggregates(e.expr, out);
      return;
    case "isnull":
      collectAggregates(e.expr, out);
      return;
    default:
      return;
  }
}

// ---- Loading tables ----

export type TableLoader = (source: string) => Promise<ParsedCsv> | ParsedCsv;

// ---- Main execution ----

export async function execute(
  q: SelectQuery,
  loader: TableLoader,
): Promise<ResultTable> {
  // 1. Load tables
  const fromTable = makeTable(
    q.from.alias,
    await Promise.resolve(loader(q.from.source)),
  );
  const tables: Table[] = [fromTable];
  for (const j of q.joins) {
    const parsed = await Promise.resolve(loader(j.table.source));
    tables.push(makeTable(j.table.alias, parsed));
  }
  const ctx = buildCtx(tables);

  // 2. Build initial joined rows from FROM
  let joined: JoinedRow[] = fromTable.rows.map((r) =>
    rowToJoined(fromTable.alias, fromTable.headers, r),
  );

  // 3. Apply JOINs
  for (let ji = 0; ji < q.joins.length; ji++) {
    const j = q.joins[ji];
    const right = ctx.tables[ji + 1]; // 0 is FROM, joins start at 1
    joined = applyInnerJoin(ctx, joined, right, j);
  }

  // 4. Apply WHERE
  if (q.where) {
    joined = joined.filter((r) =>
      isTruthy(evalExpr(ctx, r, q.where!) ?? false),
    );
  }

  // 5. Determine if aggregate query
  const aggs: FuncCall[] = [];
  for (const item of q.select) {
    if (!item.star && item.expr) collectAggregates(item.expr, aggs);
  }
  if (q.having) collectAggregates(q.having, aggs);
  // Build alias map for ORDER BY: alias name -> underlying expression
  const aliasMap: Record<string, Expr> = {};
  for (const item of q.select) {
    if (item.alias && item.expr) aliasMap[item.alias] = item.expr;
  }
  // Replace bare column refs in ORDER BY that match select aliases.
  const orderBy = q.orderBy.map<OrderItem>((o) => {
    if (o.expr.type === "column" && !o.expr.table && aliasMap[o.expr.name]) {
      return { expr: aliasMap[o.expr.name], dir: o.dir };
    }
    return o;
  });
  for (const o of orderBy) collectAggregates(o.expr, aggs);
  const isAggregate = q.groupBy.length > 0 || aggs.length > 0;

  let resultRows: { row: JoinedRow; agg?: AggContext }[];

  if (isAggregate) {
    // Group rows by group-by key
    const groups = new Map<string, JoinedRow[]>();
    if (q.groupBy.length === 0) {
      groups.set("__all__", joined);
    } else {
      for (const r of joined) {
        const key = q.groupBy
          .map((c) => {
            const v = getCellTyped(ctx, r, c);
            return v === null ? "\u0000" : String(v);
          })
          .join("\u0001");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
    }
    resultRows = [];
    for (const [, rows] of groups) {
      const aggCtx = computeAggregates(ctx, rows, aggs);
      // Representative row: first row of the group (used for non-aggregate
      // group-by columns in select).
      const repr = rows[0] ?? makeEmptyJoined(tables);
      resultRows.push({ row: repr, agg: aggCtx });
    }
    // HAVING
    if (q.having) {
      resultRows = resultRows.filter(({ row, agg }) =>
        isTruthy(evalExpr(ctx, row, q.having!, agg) ?? false),
      );
    }
  } else {
    resultRows = joined.map((r) => ({ row: r }));
  }

  // 6. ORDER BY
  if (orderBy.length > 0) {
    resultRows.sort((a, b) => {
      for (const o of orderBy) {
        const va = evalExpr(ctx, a.row, o.expr, a.agg);
        const vb = evalExpr(ctx, b.row, o.expr, b.agg);
        let cmp = compareValues(va, vb);
        if (o.dir === "DESC") cmp = -cmp;
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  // 7. OFFSET / LIMIT
  if (q.offset) {
    resultRows = resultRows.slice(q.offset);
  }
  if (q.limit !== null && q.limit !== undefined) {
    resultRows = resultRows.slice(0, q.limit);
  }

  // 8. Project SELECT
  return projectSelect(ctx, q.select, resultRows);
}

function rowToJoined(alias: string, headers: string[], row: Row): JoinedRow {
  const out: JoinedRow = {};
  for (const h of headers) {
    out[alias + "." + h] = row[h] ?? "";
  }
  return out;
}

function makeEmptyJoined(tables: Table[]): JoinedRow {
  const out: JoinedRow = {};
  for (const t of tables) {
    for (const h of t.headers) {
      out[t.alias + "." + h] = "";
    }
  }
  return out;
}

function applyInnerJoin(
  ctx: ExecCtx,
  left: JoinedRow[],
  right: Table,
  j: JoinClause,
): JoinedRow[] {
  const out: JoinedRow[] = [];
  for (const lr of left) {
    for (const rr of right.rows) {
      const merged: JoinedRow = { ...lr };
      for (const h of right.headers) {
        merged[right.alias + "." + h] = rr[h] ?? "";
      }
      const cond = evalExpr(ctx, merged, j.on);
      if (isTruthy(cond ?? false)) out.push(merged);
    }
  }
  return out;
}

function computeAggregates(
  ctx: ExecCtx,
  rows: JoinedRow[],
  aggs: FuncCall[],
): AggContext {
  const values = new Map<string, Value>();
  for (const a of aggs) {
    const key = aggKey(a);
    if (values.has(key)) continue;
    values.set(key, computeOneAggregate(ctx, rows, a));
  }
  return { values };
}

function computeOneAggregate(
  ctx: ExecCtx,
  rows: JoinedRow[],
  a: FuncCall,
): Value {
  if (a.name === "COUNT") {
    if (a.star) return rows.length;
    let c = 0;
    for (const r of rows) {
      const v = evalExpr(ctx, r, a.args[0]);
      if (v !== null) c++;
    }
    return c;
  }
  if (a.name === "SUM" || a.name === "AVG") {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const v = evalExpr(ctx, r, a.args[0]);
      if (v === null) continue;
      const num = toNumberMaybe(v);
      if (num === null) throw new ExecError(`${a.name} on non-numeric value`);
      sum += num;
      n++;
    }
    if (a.name === "SUM") return n === 0 ? null : sum;
    return n === 0 ? null : sum / n;
  }
  if (a.name === "MIN" || a.name === "MAX") {
    let best: Value = null;
    let init = false;
    for (const r of rows) {
      const v = evalExpr(ctx, r, a.args[0]);
      if (v === null) continue;
      if (!init) {
        best = v;
        init = true;
        continue;
      }
      const cmp = compareValues(v, best);
      if ((a.name === "MIN" && cmp < 0) || (a.name === "MAX" && cmp > 0)) {
        best = v;
      }
    }
    return init ? best : null;
  }
  throw new ExecError(`unknown aggregate ${a.name}`);
}

function projectSelect(
  ctx: ExecCtx,
  select: SelectItem[],
  rows: { row: JoinedRow; agg?: AggContext }[],
): ResultTable {
  // Determine output headers
  const headers: string[] = [];
  const projectors: ((
    r: JoinedRow,
    agg?: AggContext,
  ) => Record<string, Value>)[] = [];

  for (const item of select) {
    if (item.star) {
      const tablesToInclude = item.starTable
        ? ctx.tables.filter((t) => t.alias === item.starTable)
        : ctx.tables;
      if (item.starTable && tablesToInclude.length === 0) {
        throw new ExecError(`unknown table alias '${item.starTable}'`);
      }
      for (const t of tablesToInclude) {
        for (const h of t.headers) {
          // For unique single-table queries, use plain header. For multi-table
          // queries, qualify to avoid collisions.
          const isMulti = ctx.tables.length > 1;
          const colName = isMulti ? `${t.alias}.${h}` : h;
          headers.push(colName);
          const alias = t.alias;
          const col = h;
          const ty = t.colTypes[h];
          projectors.push((r) => {
            const raw = getCellRaw(r, alias, col);
            if (raw === "") return { [colName]: null };
            if (ty === "number") {
              const n = Number(raw);
              return { [colName]: Number.isFinite(n) ? n : raw };
            }
            return { [colName]: raw };
          });
        }
      }
    } else {
      const expr = item.expr!;
      const name = item.alias ?? exprToHeader(expr);
      headers.push(name);
      projectors.push((r, agg) => ({ [name]: evalExpr(ctx, r, expr, agg) }));
    }
  }

  // Deduplicate headers (very rare, but guard)
  // We keep first occurrence; later collisions are renamed.
  const seen = new Set<string>();
  const finalHeaders: string[] = [];
  const renameMap: Record<number, string> = {};
  headers.forEach((h, i) => {
    let n = h;
    let k = 2;
    while (seen.has(n)) {
      n = `${h}_${k++}`;
    }
    seen.add(n);
    finalHeaders.push(n);
    if (n !== h) renameMap[i] = n;
  });

  const outRows: Record<string, Value>[] = [];
  for (const { row, agg } of rows) {
    const out: Record<string, Value> = {};
    for (let i = 0; i < select.length; i++) {
      // For star, projectors length might exceed select length; handle separately
    }
    // Re-iterate projectors and headers in lock-step.
    for (let i = 0; i < projectors.length; i++) {
      const p = projectors[i](row, agg);
      const k = Object.keys(p)[0];
      const finalName = renameMap[i] ?? k;
      out[finalName] = p[k];
    }
    outRows.push(out);
  }

  return { headers: finalHeaders, rows: outRows };
}

function exprToHeader(e: Expr): string {
  switch (e.type) {
    case "column":
      return e.table ? `${e.table}.${e.name}` : e.name;
    case "number":
      return String(e.value);
    case "string":
      return `'${e.value}'`;
    case "null":
      return "NULL";
    case "bool":
      return e.value ? "TRUE" : "FALSE";
    case "unary":
      return `${e.op}${exprToHeader(e.expr)}`;
    case "binary":
      return `${exprToHeader(e.left)}${e.op}${exprToHeader(e.right)}`;
    case "isnull":
      return `${exprToHeader(e.expr)} IS ${e.negate ? "NOT " : ""}NULL`;
    case "func":
      if (e.star) return `${e.name}(*)`;
      return `${e.name}(${e.args.map(exprToHeader).join(",")})`;
  }
}

// ---- Output formatting ----

export function formatResult(
  result: ResultTable,
  format: "csv" | "json" | "table",
): string {
  if (format === "json") {
    return JSON.stringify(result.rows, valueReplacer, 2) + "\n";
  }
  if (format === "table") {
    return formatTable(result);
  }
  // CSV
  const stringRows = result.rows.map((r) => {
    const out: Row = {};
    for (const h of result.headers) {
      out[h] = valueToString(r[h]);
    }
    return out;
  });
  return serializeCsv(result.headers, stringRows);
}

function valueReplacer(_k: string, v: any): any {
  return v;
}

function valueToString(v: Value): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function formatTable(result: ResultTable): string {
  const { headers, rows } = result;
  const widths = headers.map((h) => h.length);
  const cells: string[][] = rows.map((r) =>
    headers.map((h, i) => {
      const s = valueToString(r[h]);
      if (s.length > widths[i]) widths[i] = s.length;
      return s;
    }),
  );
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cols: string[]) =>
    "|" + cols.map((c, i) => " " + c.padEnd(widths[i]) + " ").join("|") + "|";
  const lines: string[] = [];
  lines.push(sep);
  lines.push(fmtRow(headers));
  lines.push(sep);
  for (const r of cells) lines.push(fmtRow(r));
  lines.push(sep);
  return lines.join("\n") + "\n";
}
