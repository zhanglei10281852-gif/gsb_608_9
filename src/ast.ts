export type ASTNode =
  | SelectStatement
  | BinaryExpr
  | NotExpr
  | LiteralExpr
  | ColumnRef
  | StarExpr
  | AggregateExpr
  | LikeExpr
  | OrderByItem
  | JoinClause;

export interface SelectStatement {
  type: 'SelectStatement';
  columns: (StarExpr | ColumnRef | AggregateExpr | { expr: ASTNode; alias?: string })[];
  from: string;
  joins?: JoinClause[];
  where?: ASTNode;
  groupBy?: ColumnRef[];
  having?: ASTNode;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
}

export interface StarExpr {
  type: 'StarExpr';
  table?: string;
}

export interface ColumnRef {
  type: 'ColumnRef';
  table?: string;
  name: string;
}

export interface LiteralExpr {
  type: 'LiteralExpr';
  value: string | number;
}

export interface BinaryExpr {
  type: 'BinaryExpr';
  op: 'AND' | 'OR' | '=' | '!=' | '<' | '<=' | '>' | '>=';
  left: ASTNode;
  right: ASTNode;
}

export interface NotExpr {
  type: 'NotExpr';
  expr: ASTNode;
}

export interface LikeExpr {
  type: 'LikeExpr';
  left: ASTNode;
  pattern: string;
}

export interface AggregateExpr {
  type: 'AggregateExpr';
  func: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  arg: StarExpr | ColumnRef;
}

export interface OrderByItem {
  type: 'OrderByItem';
  expr: ASTNode;
  order: 'ASC' | 'DESC';
}

export interface JoinClause {
  type: 'JoinClause';
  table: string;
  leftCol: ColumnRef;
  rightCol: ColumnRef;
}
