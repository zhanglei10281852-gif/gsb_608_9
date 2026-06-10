export interface SelectStatement {
  type: 'select';
  columns: SelectColumn[];
  from: TableRef;
  joins?: JoinClause[];
  where?: Expression;
  groupBy?: string[];
  having?: Expression;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
}

export interface SelectColumn {
  expression: Expression;
  alias?: string;
}

export interface TableRef {
  tableName: string;
  alias?: string;
}

export interface JoinClause {
  type: 'inner';
  table: TableRef;
  on: Expression;
}

export interface OrderByItem {
  expression: Expression;
  direction: 'asc' | 'desc';
}

export type Expression =
  | LiteralExpression
  | ColumnExpression
  | BinaryExpression
  | UnaryExpression
  | FunctionCallExpression
  | WildcardExpression;

export interface LiteralExpression {
  type: 'literal';
  value: string | number | boolean | null;
  valueType: 'string' | 'number' | 'boolean' | 'null';
}

export interface ColumnExpression {
  type: 'column';
  tableName?: string;
  columnName: string;
}

export interface WildcardExpression {
  type: 'wildcard';
  tableName?: string;
}

export interface BinaryExpression {
  type: 'binary';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type BinaryOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'and'
  | 'or'
  | 'like'
  | '+'
  | '-';

export interface UnaryExpression {
  type: 'unary';
  operator: UnaryOperator;
  operand: Expression;
}

export type UnaryOperator = 'not' | '-' | '+';

export interface FunctionCallExpression {
  type: 'function';
  functionName: string;
  arguments: Expression[];
}

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Row {
  [key: string]: string | number;
}

export interface TableData {
  headers: string[];
  rows: Row[];
  columnTypes: Map<string, 'string' | 'number'>;
}
