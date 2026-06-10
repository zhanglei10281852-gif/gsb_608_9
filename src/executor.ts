import * as AST from './ast';
import { parseCSV, ParsedCSV } from './csv';
import * as fs from 'fs';

type Row = Record<string, string | number>;

interface TableData {
  [tableName: string]: ParsedCSV;
}

export interface QueryResult {
  headers: string[];
  rows: Row[];
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '');
}

function likeMatch(value: string, pattern: string): boolean {
  let regexPattern = '^';
  for (const ch of pattern) {
    if (ch === '%') {
      regexPattern += '.*';
    } else if (ch === '_') {
      regexPattern += '.';
    } else {
      regexPattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexPattern += '$';
  return new RegExp(regexPattern, 'i').test(value);
}

function compareValues(a: string | number, b: string | number, op: string): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
  } else {
    const sa = String(a);
    const sb = String(b);
    switch (op) {
      case '=': return sa === sb;
      case '!=': return sa !== sb;
      case '<': return sa < sb;
      case '<=': return sa <= sb;
      case '>': return sa > sb;
      case '>=': return sa >= sb;
    }
  }
  return false;
}

function getColumnValue(row: Row, col: AST.ColumnRef, tableMap: Map<string, string>): string | number {
  let colName = col.name;
  if (col.table) {
    const prefix = tableMap.get(col.table);
    if (prefix !== undefined) {
      const prefixed = prefix ? prefix + '_' + col.name : col.name;
      if (prefixed in row) return row[prefixed];
    }
  }
  if (colName in row) return row[colName];
  for (const key of Object.keys(row)) {
    if (key.endsWith('_' + colName)) return row[key];
  }
  return '';
}

function resolveExpr(
  expr: AST.ASTNode,
  row: Row,
  tableMap: Map<string, string>
): string | number | boolean {
  switch (expr.type) {
    case 'LiteralExpr':
      return (expr as AST.LiteralExpr).value;
    case 'ColumnRef': {
      const col = expr as AST.ColumnRef;
      return getColumnValue(row, col, tableMap);
    }
    case 'BinaryExpr': {
      const b = expr as AST.BinaryExpr;
      if (b.op === 'AND') {
        return !!(resolveExpr(b.left, row, tableMap)) && !!(resolveExpr(b.right, row, tableMap));
      }
      if (b.op === 'OR') {
        return !!(resolveExpr(b.left, row, tableMap)) || !!(resolveExpr(b.right, row, tableMap));
      }
      const lv = resolveExpr(b.left, row, tableMap);
      const rv = resolveExpr(b.right, row, tableMap);
      return compareValues(lv as string | number, rv as string | number, b.op);
    }
    case 'NotExpr': {
      const n = expr as AST.NotExpr;
      return !resolveExpr(n.expr, row, tableMap);
    }
    case 'LikeExpr': {
      const l = expr as AST.LikeExpr;
      const lv = String(resolveExpr(l.left, row, tableMap));
      return likeMatch(lv, l.pattern);
    }
    case 'AggregateExpr': {
      const a = expr as AST.AggregateExpr;
      const argStr = a.arg.type === 'StarExpr' ? '*' : (a.arg as AST.ColumnRef).name;
      const colName = `${a.func}(${argStr})`;
      if (colName in row) return row[colName];
      return 0;
    }
    default:
      return '';
  }
}

function computeAggregate(
  func: string,
  values: (string | number)[],
  isStar: boolean,
  countAll: number
): number {
  switch (func) {
    case 'COUNT':
      if (isStar) return countAll;
      return values.filter(v => v !== null && v !== undefined && v !== '').length;
    case 'SUM':
      return values.filter(v => typeof v === 'number').reduce((a, b) => a + (b as number), 0);
    case 'AVG': {
      const nums = values.filter(v => typeof v === 'number') as number[];
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    }
    case 'MIN': {
      const nums = values.filter(v => typeof v === 'number') as number[];
      return nums.length > 0 ? Math.min(...nums) : '' as any;
    }
    case 'MAX': {
      const nums = values.filter(v => typeof v === 'number') as number[];
      return nums.length > 0 ? Math.max(...nums) : '' as any;
    }
  }
  return 0;
}

function materializeColumnName(
  item: AST.StarExpr | AST.ColumnRef | AST.AggregateExpr | { expr: AST.ASTNode; alias?: string },
  tableMap: Map<string, string>
): string {
  if ('alias' in item && item.alias) {
    return item.alias;
  }
  if ('expr' in item) {
    return materializeColumnName(item.expr as any, tableMap);
  }
  if (item.type === 'StarExpr') return '*';
  if (item.type === 'ColumnRef') {
    const c = item as AST.ColumnRef;
    if (c.table) {
      const prefix = tableMap.get(c.table);
      if (prefix) return prefix + '_' + c.name;
    }
    return c.name;
  }
  if (item.type === 'AggregateExpr') {
    const a = item as AST.AggregateExpr;
    const argStr = a.arg.type === 'StarExpr' ? '*' : (a.arg as AST.ColumnRef).name;
    return `${a.func}(${argStr})`;
  }
  return 'col';
}

function resolveTableName(name: string, tables: TableData): string {
  if (tables[name]) return name;
  const candidates = [
    stripExt(name),
    name + '.csv',
    stripExt(name) + '.csv',
    name.split('/').pop() || name,
    name.split('\\').pop() || name,
  ];
  for (const c of candidates) {
    if (tables[c]) return c;
  }
  return name;
}

function getBaseName(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1];
}

export function executeQuery(
  ast: AST.SelectStatement,
  tables: TableData
): QueryResult {
  let tableMap = new Map<string, string>();
  let primaryTable = resolveTableName(ast.from, tables);

  tableMap.set(primaryTable, '');
  tableMap.set(stripExt(primaryTable), '');
  const primaryBase = getBaseName(primaryTable);
  tableMap.set(primaryBase, '');
  tableMap.set(stripExt(primaryBase), '');
  tableMap.set(ast.from, '');
  tableMap.set(stripExt(ast.from), '');

  let rows: Row[] = [...tables[primaryTable].rows];

  if (ast.joins) {
    for (const join of ast.joins) {
      let joinTableName = resolveTableName(join.table, tables);
      const joinBase = getBaseName(joinTableName);
      const joinPrefix = stripExt(joinBase);
      tableMap.set(joinTableName, joinPrefix);
      tableMap.set(stripExt(joinTableName), joinPrefix);
      tableMap.set(joinBase, joinPrefix);
      tableMap.set(stripExt(joinBase), joinPrefix);
      tableMap.set(join.table, joinPrefix);
      tableMap.set(stripExt(join.table), joinPrefix);

      const joinData = tables[joinTableName];
      const newRows: Row[] = [];

      for (const leftRow of rows) {
        for (const rightRow of joinData.rows) {
          const merged: Row = { ...leftRow };
          for (const k of Object.keys(rightRow)) {
            merged[joinPrefix + '_' + k] = rightRow[k];
          }
          newRows.push(merged);
        }
      }

      const filtered = newRows.filter(row => {
        const lVal = getColumnValue(row, join.leftCol, tableMap);
        const rVal = getColumnValue(row, join.rightCol, tableMap);
        return String(lVal) === String(rVal);
      });

      rows = filtered;
    }
  }

  if (ast.where) {
    rows = rows.filter(row => !!resolveExpr(ast.where!, row, tableMap));
  }

  let resultHeaders: string[] = [];
  let resultRows: Row[] = [];

  const hasAggregate = ast.columns.some(c => {
    if ('expr' in c) return c.expr.type === 'AggregateExpr';
    return c.type === 'AggregateExpr';
  });
  if (ast.groupBy || hasAggregate) {
    const groupKeys = ast.groupBy || [];
    
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const keyParts = groupKeys.map(gk => String(getColumnValue(row, gk, tableMap)));
      const key = keyParts.join('\x00');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    for (const [key, groupRows] of groups) {
      const outRow: Row = {};
      const keyVals = key.split('\x00');
      groupKeys.forEach((gk, i) => {
        outRow[gk.name] = keyVals[i];
        const k = getColumnValue(groupRows[0], gk, tableMap);
        if (typeof k === 'number') {
          outRow[gk.name] = k;
        }
      });

      for (const col of ast.columns) {
        let colExpr: AST.ASTNode;
        let alias: string | undefined;
        if ('alias' in col) {
          colExpr = col.expr;
          alias = col.alias;
        } else {
          colExpr = col as AST.ASTNode;
        }
        const headerName = alias || materializeColumnName(col as any, tableMap);
        
        if (colExpr.type === 'AggregateExpr') {
          const agg = colExpr as AST.AggregateExpr;
          const isStar = agg.arg.type === 'StarExpr';
          let values: (string | number)[];
          if (isStar) {
            values = [];
          } else {
            const cr = agg.arg as AST.ColumnRef;
            values = groupRows.map(r => getColumnValue(r, cr, tableMap));
          }
          const aggValue = computeAggregate(agg.func, values, isStar, groupRows.length);
          outRow[headerName] = aggValue;
          const argStr = isStar ? '*' : (agg.arg as AST.ColumnRef).name;
          const origName = `${agg.func}(${argStr})`;
          if (origName !== headerName) {
            outRow[origName] = aggValue;
          }
        } else if (colExpr.type === 'ColumnRef') {
          const cr = colExpr as AST.ColumnRef;
          outRow[headerName] = getColumnValue(groupRows[0], cr, tableMap);
        }
      }

      let include = true;
      if (ast.having) {
        include = !!resolveExpr(ast.having, outRow, tableMap);
      }
      if (include) {
        resultRows.push(outRow);
      }
    }
  } else {
    for (const row of rows) {
      const outRow: Row = {};
      const hasStar = ast.columns.some(c => {
        if ('expr' in c) return c.expr.type === 'StarExpr';
        return c.type === 'StarExpr';
      });
      
      if (hasStar) {
        for (const k of Object.keys(row)) {
          outRow[k] = row[k];
        }
      }
      
      for (const col of ast.columns) {
        let colExpr: AST.ASTNode;
        let alias: string | undefined;
        if ('alias' in col) {
          colExpr = col.expr;
          alias = col.alias;
        } else {
          colExpr = col as AST.ASTNode;
        }
        
        if (colExpr.type === 'StarExpr') continue;
        
        const headerName = alias || materializeColumnName(col as any, tableMap);
        outRow[headerName] = resolveExpr(colExpr, row, tableMap) as string | number;
      }
      resultRows.push(outRow);
    }
  }

  function isStarCol(c: any): boolean {
    if ('expr' in c) return c.expr.type === 'StarExpr';
    return c.type === 'StarExpr';
  }
  resultHeaders = [];
  const firstRow = resultRows[0];
  if (ast.columns.some(isStarCol)) {
    if (firstRow) {
      resultHeaders = Object.keys(firstRow);
    } else {
      resultHeaders = ast.columns
        .filter(c => !isStarCol(c))
        .map(c => materializeColumnName(c as any, tableMap));
    }
  } else {
    resultHeaders = ast.columns.map(c => materializeColumnName(c as any, tableMap));
  }

  if (ast.orderBy) {
    resultRows.sort((a, b) => {
      for (const ob of ast.orderBy!) {
        const va = resolveExpr(ob.expr, a, tableMap);
        const vb = resolveExpr(ob.expr, b, tableMap);
        let cmp: number;
        if (typeof va === 'number' && typeof vb === 'number') {
          cmp = va - vb;
        } else {
          cmp = String(va).localeCompare(String(vb), undefined, { numeric: false });
        }
        if (cmp !== 0) {
          return ob.order === 'DESC' ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  if (ast.offset) {
    resultRows = resultRows.slice(ast.offset);
  }
  if (ast.limit !== undefined) {
    resultRows = resultRows.slice(0, ast.limit);
  }

  const seen = new Set<string>();
  const finalHeaders: string[] = [];
  for (const h of resultHeaders) {
    if (!seen.has(h)) {
      seen.add(h);
      finalHeaders.push(h);
    }
  }

  return { headers: finalHeaders, rows: resultRows };
}
