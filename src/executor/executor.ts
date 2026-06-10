import * as fs from 'fs';
import * as path from 'path';
import {
  SelectStatement,
  Expression,
  Row,
  TableData,
  BinaryOperator,
  ColumnExpression,
  FunctionCallExpression,
  SelectColumn,
  OrderByItem,
  JoinClause,
} from '../sql/ast';
import { parseCSV } from '../csv/parser';

export interface QueryResult {
  headers: string[];
  rows: Row[];
}

interface ExecutionContext {
  tables: Map<string, TableData>;
  currentRow: Row;
  tableAlias: Map<string, string>;
  columnTypes: Map<string, 'string' | 'number'>;
}

export function executeQuery(
  sql: SelectStatement,
  baseDir: string,
  stdinContent: string = ''
): QueryResult {
  const context: ExecutionContext = {
    tables: new Map(),
    currentRow: {},
    tableAlias: new Map(),
    columnTypes: new Map(),
  };

  const mainTable = loadTable(sql.from.tableName, baseDir, stdinContent);
  const mainAlias = sql.from.alias || sql.from.tableName;
  context.tables.set(mainAlias, mainTable);
  context.tableAlias.set(mainAlias, mainAlias);

  let resultRows = [...mainTable.rows];
  let resultHeaders = [...mainTable.headers];
  let resultTypes = new Map(mainTable.columnTypes);

  if (sql.joins && sql.joins.length > 0) {
    for (const join of sql.joins) {
      const joinTable = loadTable(join.table.tableName, baseDir, stdinContent);
      const joinAlias = join.table.alias || join.table.tableName;
      context.tables.set(joinAlias, joinTable);
      context.tableAlias.set(joinAlias, joinAlias);

      resultRows = executeInnerJoin(resultRows, joinTable.rows, join, mainAlias, joinAlias);
      resultHeaders = [...resultHeaders, ...joinTable.headers.map(h => `${joinAlias}.${h}`)];
      joinTable.columnTypes.forEach((value, key) => {
        resultTypes.set(`${joinAlias}.${key}`, value);
      });
    }
  }

  if (sql.where) {
    resultRows = resultRows.filter(row => {
      context.currentRow = row;
      return evaluateBooleanExpression(sql.where!, context);
    });
  }

  let finalRows: Row[];
  let finalHeaders: string[];

  if (sql.groupBy || hasAggregateFunctions(sql.columns)) {
    const groupKeys = sql.groupBy || [];
    const groups = groupRows(resultRows, groupKeys, context);

    let filteredGroups = groups;
    if (sql.having) {
      const havingExpr = sql.having;
      filteredGroups = new Map<string, Row[]>();
      groups.forEach((rows, key) => {
        if (evaluateGroupBooleanExpression(havingExpr, rows, context)) {
          filteredGroups.set(key, rows);
        }
      });
    }

    const aggResult = computeAggregatedResult(filteredGroups, groupKeys, sql.columns, context);
    finalRows = aggResult.rows;
    finalHeaders = aggResult.headers;
  } else {
    const selectedColumns = processSelectColumns(sql.columns, resultRows, resultHeaders, resultTypes, false, context);
    finalRows = selectedColumns.rows;
    finalHeaders = selectedColumns.headers;
  }

  if (sql.orderBy && sql.orderBy.length > 0) {
    finalRows = executeOrderBy(finalRows, sql.orderBy, context);
  }

  if (sql.offset !== undefined) {
    finalRows = finalRows.slice(sql.offset);
  }

  if (sql.limit !== undefined) {
    finalRows = finalRows.slice(0, sql.limit);
  }

  return {
    headers: finalHeaders,
    rows: finalRows,
  };
}

function loadTable(tableName: string, baseDir: string, stdinContent: string): TableData {
  if (tableName === 'stdin') {
    if (!stdinContent || stdinContent.trim() === '') {
      throw new Error('No data from stdin. Pipe CSV data to stdin or use a file.');
    }
    return parseCSV(stdinContent);
  }

  const filePath = path.isAbsolute(tableName)
    ? tableName
    : path.join(baseDir, tableName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Table file not found: ${tableName}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseCSV(content);
}

function executeInnerJoin(
  leftRows: Row[],
  rightRows: Row[],
  join: JoinClause,
  leftAlias: string,
  rightAlias: string
): Row[] {
  const result: Row[] = [];

  for (const leftRow of leftRows) {
    for (const rightRow of rightRows) {
      const combinedRow: Row = {};
      
      for (const [key, value] of Object.entries(leftRow)) {
        combinedRow[key] = value;
        combinedRow[`${leftAlias}.${key}`] = value;
      }
      
      for (const [key, value] of Object.entries(rightRow)) {
        combinedRow[`${rightAlias}.${key}`] = value;
        if (!(key in combinedRow)) {
          combinedRow[key] = value;
        }
      }

      const context = {
        currentRow: combinedRow,
        tables: new Map(),
        tableAlias: new Map(),
        columnTypes: new Map(),
      };

      if (evaluateBooleanExpression(join.on, context)) {
        result.push(combinedRow);
      }
    }
  }

  return result;
}

function groupRows(
  rows: Row[],
  groupKeys: string[],
  context: ExecutionContext
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    context.currentRow = row;
    const keyParts = groupKeys.map(key => {
      const expr: ColumnExpression = { type: 'column', columnName: key };
      return String(evaluateExpression(expr, context));
    });
    const key = keyParts.join('|||');

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(row);
  }

  return groups;
}

function hasAggregateFunctions(columns: SelectColumn[]): boolean {
  for (const col of columns) {
    if (isAggregateExpression(col.expression)) {
      return true;
    }
  }
  return false;
}

function isAggregateExpression(expr: Expression): boolean {
  if (expr.type === 'function') {
    const funcExpr = expr as FunctionCallExpression;
    return ['count', 'sum', 'avg', 'min', 'max'].includes(funcExpr.functionName);
  }
  if (expr.type === 'binary') {
    return isAggregateExpression(expr.left) || isAggregateExpression(expr.right);
  }
  if (expr.type === 'unary') {
    return isAggregateExpression(expr.operand);
  }
  return false;
}

function createAggregateContext(rows: Row[], baseContext: ExecutionContext): ExecutionContext {
  return {
    ...baseContext,
    currentRow: rows[0],
  };
}

function computeAggregatedResult(
  groups: Map<string, Row[]>,
  groupKeys: string[],
  selectColumns: SelectColumn[],
  context: ExecutionContext
): { headers: string[]; rows: Row[] } {
  const headers: string[] = [];
  const expandedColumns: SelectColumn[] = [];

  for (const col of selectColumns) {
    if (col.expression.type === 'wildcard') {
      throw new Error('Cannot use * with aggregate queries');
    }
    expandedColumns.push(col);
  }

  for (const col of expandedColumns) {
    const alias = col.alias || getExpressionName(col.expression);
    headers.push(alias);
  }

  const resultRows: Row[] = [];

  groups.forEach((rows) => {
    const aggRow: Row = {};

    for (let i = 0; i < expandedColumns.length; i++) {
      const col = expandedColumns[i];
      const alias = headers[i];
      const value = computeAggregateExpression(col.expression, rows, context);
      aggRow[alias] = value ?? '';
    }

    resultRows.push(aggRow);
  });

  return { headers, rows: resultRows };
}

function computeAggregateExpression(
  expr: Expression,
  rows: Row[],
  context: ExecutionContext
): number | string | null {
  if (expr.type === 'function') {
    const funcExpr = expr as FunctionCallExpression;
    return computeAggregateFunction(funcExpr.functionName, funcExpr.arguments, rows, context);
  }

  if (expr.type === 'column') {
    context.currentRow = rows[0];
    const result = evaluateExpression(expr, context);
    return result as number | string | null;
  }

  if (expr.type === 'literal') {
    if (expr.valueType === 'boolean' || expr.valueType === 'null') {
      return String(expr.value);
    }
    return expr.value as number | string;
  }

  return null;
}

function computeAggregateFunction(
  funcName: string,
  args: Expression[],
  rows: Row[],
  context: ExecutionContext
): number | string | null {
  switch (funcName.toLowerCase()) {
    case 'count': {
      if (args.length === 1 && args[0].type === 'wildcard') {
        return rows.length;
      }
      let count = 0;
      for (const row of rows) {
        context.currentRow = row;
        const value = evaluateExpression(args[0], context);
        if (value !== null && value !== undefined && value !== '') {
          count++;
        }
      }
      return count;
    }
    case 'sum': {
      let sum = 0;
      for (const row of rows) {
        context.currentRow = row;
        const value = evaluateExpression(args[0], context);
        if (typeof value === 'number') {
          sum += value;
        } else if (typeof value === 'string') {
          const num = parseFloat(value);
          if (!isNaN(num)) {
            sum += num;
          }
        }
      }
      return sum;
    }
    case 'avg': {
      let sum = 0;
      let count = 0;
      for (const row of rows) {
        context.currentRow = row;
        const value = evaluateExpression(args[0], context);
        if (typeof value === 'number') {
          sum += value;
          count++;
        } else if (typeof value === 'string') {
          const num = parseFloat(value);
          if (!isNaN(num)) {
            sum += num;
            count++;
          }
        }
      }
      return count > 0 ? sum / count : 0;
    }
    case 'min': {
      let min: number | string | null = null;
      for (const row of rows) {
        context.currentRow = row;
        const value = evaluateExpression(args[0], context);
        if (min === null) {
          min = value;
        } else if (compareValues(value, min) < 0) {
          min = value;
        }
      }
      return min;
    }
    case 'max': {
      let max: number | string | null = null;
      for (const row of rows) {
        context.currentRow = row;
        const value = evaluateExpression(args[0], context);
        if (max === null) {
          max = value;
        } else if (compareValues(value, max) > 0) {
          max = value;
        }
      }
      return max;
    }
    default:
      throw new Error(`Unknown aggregate function: ${funcName}`);
  }
}

function processSelectColumns(
  columns: SelectColumn[],
  rows: Row[],
  headers: string[],
  types: Map<string, 'string' | 'number'>,
  aggregated: boolean,
  context: ExecutionContext
): { headers: string[]; rows: Row[] } {
  const resultHeaders: string[] = [];
  const resultRows: Row[] = [];
  const expandedColumns: SelectColumn[] = [];

  for (const col of columns) {
    if (col.expression.type === 'wildcard') {
      for (const header of headers) {
        expandedColumns.push({
          expression: { type: 'column', columnName: header },
          alias: header,
        });
      }
    } else {
      expandedColumns.push(col);
    }
  }

  for (const col of expandedColumns) {
    const alias = col.alias || getExpressionName(col.expression);
    resultHeaders.push(alias);
  }

  for (const row of rows) {
    context.currentRow = row;
    const resultRow: Row = {};

    for (let i = 0; i < expandedColumns.length; i++) {
      const col = expandedColumns[i];
      const alias = resultHeaders[i];
      resultRow[alias] = evaluateExpression(col.expression, context);
    }

    resultRows.push(resultRow);
  }

  return { headers: resultHeaders, rows: resultRows };
}

function getExpressionName(expr: Expression): string {
  if (expr.type === 'column') {
    return expr.columnName;
  }
  if (expr.type === 'function') {
    return `${expr.functionName}(${expr.arguments.map(getExpressionName).join(', ')})`;
  }
  if (expr.type === 'literal') {
    return String(expr.value);
  }
  return 'expr';
}

function executeOrderBy(
  rows: Row[],
  orderBy: OrderByItem[],
  context: ExecutionContext
): Row[] {
  return [...rows].sort((a, b) => {
    for (const item of orderBy) {
      context.currentRow = a;
      const valA = evaluateExpression(item.expression, context);
      context.currentRow = b;
      const valB = evaluateExpression(item.expression, context);

      const comparison = compareValues(valA, valB);
      if (comparison !== 0) {
        return item.direction === 'asc' ? comparison : -comparison;
      }
    }
    return 0;
  });
}

function compareValues(a: any, b: any): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  const aIsNumber = typeof a === 'number' || (!isNaN(Number(a)) && a !== '');
  const bIsNumber = typeof b === 'number' || (!isNaN(Number(b)) && b !== '');

  if (aIsNumber && bIsNumber) {
    return Number(a) - Number(b);
  }

  return String(a).localeCompare(String(b));
}

function evaluateExpression(expr: Expression, context: ExecutionContext): any {
  switch (expr.type) {
    case 'literal':
      return expr.value;

    case 'column': {
      const colExpr = expr as ColumnExpression;
      if (colExpr.tableName) {
        const key = `${colExpr.tableName}.${colExpr.columnName}`;
        if (key in context.currentRow) {
          return context.currentRow[key];
        }
      }
      if (colExpr.columnName in context.currentRow) {
        return context.currentRow[colExpr.columnName];
      }
      throw new Error(`Column not found: ${colExpr.columnName}`);
    }

    case 'binary': {
      const left = evaluateExpression(expr.left, context);
      const right = evaluateExpression(expr.right, context);
      return evaluateBinaryOperator(expr.operator, left, right);
    }

    case 'unary': {
      const operand = evaluateExpression(expr.operand, context);
      return evaluateUnaryOperator(expr.operator, operand);
    }

    case 'function': {
      const funcExpr = expr as FunctionCallExpression;
      const args = funcExpr.arguments.map(arg => evaluateExpression(arg, context));
      return evaluateFunction(funcExpr.functionName, args);
    }

    case 'wildcard':
      return '*';

    default:
      const _exhaustiveCheck: never = expr;
      throw new Error(`Unknown expression type: ${(_exhaustiveCheck as any).type}`);
  }
}

function evaluateBooleanExpression(expr: Expression, context: ExecutionContext): boolean {
  const result = evaluateExpression(expr, context);
  return Boolean(result);
}

function evaluateGroupExpression(
  expr: Expression,
  rows: Row[],
  context: ExecutionContext
): any {
  switch (expr.type) {
    case 'literal':
      return expr.value;

    case 'column': {
      context.currentRow = rows[0];
      return evaluateExpression(expr, context);
    }

    case 'binary': {
      const left = evaluateGroupExpression(expr.left, rows, context);
      const right = evaluateGroupExpression(expr.right, rows, context);
      return evaluateBinaryOperator(expr.operator, left, right);
    }

    case 'unary': {
      const operand = evaluateGroupExpression(expr.operand, rows, context);
      return evaluateUnaryOperator(expr.operator, operand);
    }

    case 'function': {
      const funcExpr = expr as FunctionCallExpression;
      return computeAggregateFunction(
        funcExpr.functionName,
        funcExpr.arguments,
        rows,
        context
      );
    }

    case 'wildcard':
      return '*';

    default:
      const _exhaustiveCheck: never = expr;
      throw new Error(`Unknown expression type: ${(_exhaustiveCheck as any).type}`);
  }
}

function evaluateGroupBooleanExpression(
  expr: Expression,
  rows: Row[],
  context: ExecutionContext
): boolean {
  const result = evaluateGroupExpression(expr, rows, context);
  return Boolean(result);
}

function evaluateBinaryOperator(operator: BinaryOperator, left: any, right: any): any {
  switch (operator) {
    case '=':
      return compareValues(left, right) === 0;
    case '!=':
      return compareValues(left, right) !== 0;
    case '<':
      return compareValues(left, right) < 0;
    case '<=':
      return compareValues(left, right) <= 0;
    case '>':
      return compareValues(left, right) > 0;
    case '>=':
      return compareValues(left, right) >= 0;
    case 'and':
      return Boolean(left) && Boolean(right);
    case 'or':
      return Boolean(left) || Boolean(right);
    case 'like':
      return evaluateLike(left, right);
    case '+':
      if (typeof left === 'number' && typeof right === 'number') {
        return left + right;
      }
      return String(left) + String(right);
    case '-':
      return Number(left) - Number(right);
    default:
      throw new Error(`Unknown binary operator: ${operator}`);
  }
}

function evaluateLike(value: any, pattern: any): boolean {
  const strValue = String(value);
  const strPattern = String(pattern);

  let regexPattern = '';
  let i = 0;

  while (i < strPattern.length) {
    const char = strPattern[i];
    if (char === '%') {
      regexPattern += '.*';
    } else if (char === '_') {
      regexPattern += '.';
    } else if (['.', '*', '+', '?', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(char)) {
      regexPattern += '\\' + char;
    } else {
      regexPattern += char;
    }
    i++;
  }

  const regex = new RegExp('^' + regexPattern + '$', 'i');
  return regex.test(strValue);
}

function evaluateUnaryOperator(operator: string, operand: any): any {
  switch (operator) {
    case 'not':
      return !operand;
    case '-':
      return -Number(operand);
    case '+':
      return Number(operand);
    default:
      throw new Error(`Unknown unary operator: ${operator}`);
  }
}

function evaluateFunction(funcName: string, args: any[]): any {
  switch (funcName.toLowerCase()) {
    case 'count':
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      throw new Error(`Aggregate function ${funcName} must be used with GROUP BY`);
    default:
      throw new Error(`Unknown function: ${funcName}`);
  }
}
