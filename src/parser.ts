// SQL parser: hand-written recursive descent producing an AST.
// Supported grammar (informal):
//
// query        := SELECT select_list FROM table_ref [join_clause]
//                 [WHERE expr] [GROUP BY ident_list [HAVING expr]]
//                 [ORDER BY order_list] [LIMIT number [OFFSET number]] [;]
// select_list  := select_item ("," select_item)*
// select_item  := "*" | expr [AS? IDENT]
// table_ref    := ident [AS? IDENT]    (ident may include extension via dot, e.g. people.csv)
// join_clause  := INNER? JOIN table_ref ON expr
// order_list   := order_item ("," order_item)*
// order_item   := expr [ASC|DESC]
// expr         := or_expr
// or_expr      := and_expr (OR and_expr)*
// and_expr     := not_expr (AND not_expr)*
// not_expr     := NOT not_expr | comparison
// comparison   := additive [ ("="|"!="|"<"|"<="|">"|">="|"LIKE") additive
//                          | "IS" "NOT"? "NULL" ]
// additive     := mul ( ("+"|"-") mul )*
// mul          := unary ( ("*"|"/"|"%") unary )*
// unary        := "-" unary | primary
// primary      := NUMBER | STRING | NULL | TRUE | FALSE
//               | ident_or_func
//               | "(" expr ")"
// ident_or_func := IDENT ("." IDENT)? | IDENT "(" (STAR | expr ("," expr)*)? ")"

import { Token, tokenize } from "./lexer";

export interface ColumnRef {
  type: "column";
  table: string | null; // qualifier, e.g. "people"
  name: string;
}

export interface NumberLit {
  type: "number";
  value: number;
}
export interface StringLit {
  type: "string";
  value: string;
}
export interface NullLit {
  type: "null";
}
export interface BoolLit {
  type: "bool";
  value: boolean;
}

export interface BinaryExpr {
  type: "binary";
  op: string; // = != < <= > >= AND OR + - * / % LIKE
  left: Expr;
  right: Expr;
}
export interface UnaryExpr {
  type: "unary";
  op: string; // NOT, -
  expr: Expr;
}
export interface IsNullExpr {
  type: "isnull";
  expr: Expr;
  negate: boolean;
}
export interface FuncCall {
  type: "func";
  name: string; // upper case
  star: boolean; // COUNT(*)
  args: Expr[];
}

export type Expr =
  | ColumnRef
  | NumberLit
  | StringLit
  | NullLit
  | BoolLit
  | BinaryExpr
  | UnaryExpr
  | IsNullExpr
  | FuncCall;

export interface SelectItem {
  // when star=true, it's "*" or "table.*" (table set when qualified)
  star?: boolean;
  starTable?: string | null;
  expr?: Expr;
  alias?: string;
}

export interface TableRef {
  // The SQL identifier/file path for the table. May contain a dot
  // (e.g. people.csv). The CLI is responsible for resolving this to data.
  source: string;
  alias: string; // defaults to base name without extension if not given
}

export interface JoinClause {
  kind: "INNER";
  table: TableRef;
  on: Expr;
}

export interface OrderItem {
  expr: Expr;
  dir: "ASC" | "DESC";
}

export interface SelectQuery {
  select: SelectItem[];
  from: TableRef;
  joins: JoinClause[];
  where: Expr | null;
  groupBy: ColumnRef[];
  having: Expr | null;
  orderBy: OrderItem[];
  limit: number | null;
  offset: number | null;
}

export class ParseError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(`Parse error at position ${pos}: ${msg}`);
    this.pos = pos;
  }
}

export function parse(sql: string): SelectQuery {
  const tokens = tokenize(sql);
  const p = new Parser(tokens);
  const q = p.parseQuery();
  p.expectEof();
  return q;
}

class Parser {
  pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(off = 0): Token {
    return this.tokens[this.pos + off];
  }
  private consume(): Token {
    return this.tokens[this.pos++];
  }
  private expectKeyword(kw: string): Token {
    const t = this.peek();
    if (t.type !== "KEYWORD" || t.value !== kw) {
      throw new ParseError(`expected ${kw}, got ${describe(t)}`, t.pos);
    }
    return this.consume();
  }
  private accept(type: string, value?: string): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) {
      return this.consume();
    }
    return null;
  }
  private acceptKeyword(kw: string): Token | null {
    return this.accept("KEYWORD", kw);
  }

  expectEof() {
    // Optional trailing semicolon
    this.accept("PUNCT", ";");
    const t = this.peek();
    if (t.type !== "EOF") {
      throw new ParseError(`unexpected ${describe(t)}`, t.pos);
    }
  }

  parseQuery(): SelectQuery {
    this.expectKeyword("SELECT");
    const select = this.parseSelectList();
    this.expectKeyword("FROM");
    const from = this.parseTableRef();
    const joins: JoinClause[] = [];
    while (true) {
      const t = this.peek();
      if (t.type === "KEYWORD" && (t.value === "INNER" || t.value === "JOIN")) {
        joins.push(this.parseJoin());
      } else {
        break;
      }
    }
    let where: Expr | null = null;
    if (this.acceptKeyword("WHERE")) {
      where = this.parseExpr();
    }
    let groupBy: ColumnRef[] = [];
    let having: Expr | null = null;
    if (this.acceptKeyword("GROUP")) {
      this.expectKeyword("BY");
      groupBy = this.parseColumnRefList();
      if (this.acceptKeyword("HAVING")) {
        having = this.parseExpr();
      }
    }
    let orderBy: OrderItem[] = [];
    if (this.acceptKeyword("ORDER")) {
      this.expectKeyword("BY");
      orderBy = this.parseOrderList();
    }
    let limit: number | null = null;
    let offset: number | null = null;
    if (this.acceptKeyword("LIMIT")) {
      const n = this.expectNumber();
      limit = n;
      if (this.acceptKeyword("OFFSET")) {
        offset = this.expectNumber();
      }
    }
    if (offset === null && this.acceptKeyword("OFFSET")) {
      offset = this.expectNumber();
    }
    return {
      select,
      from,
      joins,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    };
  }

  private expectNumber(): number {
    const t = this.peek();
    // allow optional unary minus
    let neg = false;
    if (t.type === "OPERATOR" && t.value === "-") {
      neg = true;
      this.consume();
    }
    const t2 = this.peek();
    if (t2.type !== "NUMBER") {
      throw new ParseError(`expected number, got ${describe(t2)}`, t2.pos);
    }
    this.consume();
    const n = Number(t2.value);
    if (!Number.isFinite(n)) {
      throw new ParseError(`invalid number ${t2.value}`, t2.pos);
    }
    return neg ? -n : n;
  }

  private parseSelectList(): SelectItem[] {
    const items: SelectItem[] = [];
    items.push(this.parseSelectItem());
    while (this.accept("PUNCT", ",")) {
      items.push(this.parseSelectItem());
    }
    return items;
  }

  private parseSelectItem(): SelectItem {
    // Bare *
    if (this.peek().type === "STAR") {
      this.consume();
      return { star: true, starTable: null };
    }
    // table.*  -> two tokens (IDENT, ., STAR)
    if (
      this.peek().type === "IDENT" &&
      this.peek(1).type === "PUNCT" &&
      this.peek(1).value === "." &&
      this.peek(2).type === "STAR"
    ) {
      const tbl = this.consume().value;
      this.consume(); // .
      this.consume(); // *
      return { star: true, starTable: tbl };
    }
    const expr = this.parseExpr();
    let alias: string | undefined;
    if (this.acceptKeyword("AS")) {
      const id = this.peek();
      if (id.type !== "IDENT") {
        throw new ParseError(
          `expected alias name, got ${describe(id)}`,
          id.pos,
        );
      }
      alias = this.consume().value;
    } else if (this.peek().type === "IDENT") {
      // implicit alias
      alias = this.consume().value;
    }
    return { expr, alias };
  }

  private parseTableRef(): TableRef {
    // table source: STRING literal (e.g. 'data/people.csv') or
    //               IDENT (".", IDENT)*  -> joined as "a.b.c"
    const first = this.peek();
    let src: string;
    if (first.type === "STRING") {
      this.consume();
      src = first.value;
    } else if (first.type === "IDENT") {
      src = this.consume().value;
      while (
        this.peek().type === "PUNCT" &&
        this.peek().value === "." &&
        this.peek(1).type === "IDENT"
      ) {
        this.consume(); // .
        src += "." + this.consume().value;
      }
    } else {
      throw new ParseError(
        `expected table name, got ${describe(first)}`,
        first.pos,
      );
    }
    let alias = defaultAlias(src);
    if (this.acceptKeyword("AS")) {
      const id = this.peek();
      if (id.type !== "IDENT") {
        throw new ParseError(
          `expected alias name, got ${describe(id)}`,
          id.pos,
        );
      }
      alias = this.consume().value;
    } else if (this.peek().type === "IDENT") {
      alias = this.consume().value;
    }
    return { source: src, alias };
  }

  private parseJoin(): JoinClause {
    if (this.acceptKeyword("INNER")) {
      // optional INNER prefix
    }
    this.expectKeyword("JOIN");
    const table = this.parseTableRef();
    this.expectKeyword("ON");
    const on = this.parseExpr();
    return { kind: "INNER", table, on };
  }

  private parseColumnRefList(): ColumnRef[] {
    const out: ColumnRef[] = [this.parseColumnRef()];
    while (this.accept("PUNCT", ",")) {
      out.push(this.parseColumnRef());
    }
    return out;
  }

  private parseColumnRef(): ColumnRef {
    const t = this.peek();
    if (t.type !== "IDENT") {
      throw new ParseError(`expected column name, got ${describe(t)}`, t.pos);
    }
    const first = this.consume().value;
    if (
      this.peek().type === "PUNCT" &&
      this.peek().value === "." &&
      this.peek(1).type === "IDENT"
    ) {
      this.consume(); // .
      const second = this.consume().value;
      return { type: "column", table: first, name: second };
    }
    return { type: "column", table: null, name: first };
  }

  private parseOrderList(): OrderItem[] {
    const out: OrderItem[] = [this.parseOrderItem()];
    while (this.accept("PUNCT", ",")) {
      out.push(this.parseOrderItem());
    }
    return out;
  }

  private parseOrderItem(): OrderItem {
    const expr = this.parseExpr();
    let dir: "ASC" | "DESC" = "ASC";
    if (this.acceptKeyword("ASC")) dir = "ASC";
    else if (this.acceptKeyword("DESC")) dir = "DESC";
    return { expr, dir };
  }

  // ---------- Expression parsing ----------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptKeyword("OR")) {
      const right = this.parseAnd();
      left = { type: "binary", op: "OR", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.acceptKeyword("AND")) {
      const right = this.parseNot();
      left = { type: "binary", op: "AND", left, right };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.acceptKeyword("NOT")) {
      const e = this.parseNot();
      return { type: "unary", op: "NOT", expr: e };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    const t = this.peek();
    if (
      t.type === "OPERATOR" &&
      ["=", "!=", "<", "<=", ">", ">="].includes(t.value)
    ) {
      this.consume();
      const right = this.parseAdditive();
      return { type: "binary", op: t.value, left, right };
    }
    if (t.type === "KEYWORD" && t.value === "LIKE") {
      this.consume();
      const right = this.parseAdditive();
      return { type: "binary", op: "LIKE", left, right };
    }
    if (t.type === "KEYWORD" && t.value === "IS") {
      this.consume();
      let negate = false;
      if (this.acceptKeyword("NOT")) negate = true;
      this.expectKeyword("NULL");
      return { type: "isnull", expr: left, negate };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMul();
    while (true) {
      const t = this.peek();
      if (t.type === "OPERATOR" && (t.value === "+" || t.value === "-")) {
        this.consume();
        const right = this.parseMul();
        left = { type: "binary", op: t.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.type === "STAR") {
        this.consume();
        const right = this.parseUnary();
        left = { type: "binary", op: "*", left, right };
      } else if (
        t.type === "OPERATOR" &&
        (t.value === "/" || t.value === "%")
      ) {
        this.consume();
        const right = this.parseUnary();
        left = { type: "binary", op: t.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === "OPERATOR" && t.value === "-") {
      this.consume();
      const e = this.parseUnary();
      return { type: "unary", op: "-", expr: e };
    }
    if (t.type === "OPERATOR" && t.value === "+") {
      this.consume();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "NUMBER") {
      this.consume();
      return { type: "number", value: Number(t.value) };
    }
    if (t.type === "STRING") {
      this.consume();
      return { type: "string", value: t.value };
    }
    if (t.type === "KEYWORD" && t.value === "NULL") {
      this.consume();
      return { type: "null" };
    }
    if (t.type === "KEYWORD" && t.value === "TRUE") {
      this.consume();
      return { type: "bool", value: true };
    }
    if (t.type === "KEYWORD" && t.value === "FALSE") {
      this.consume();
      return { type: "bool", value: false };
    }
    if (t.type === "PUNCT" && t.value === "(") {
      this.consume();
      const e = this.parseExpr();
      const cl = this.peek();
      if (cl.type !== "PUNCT" || cl.value !== ")") {
        throw new ParseError(`expected ')', got ${describe(cl)}`, cl.pos);
      }
      this.consume();
      return e;
    }
    if (t.type === "IDENT") {
      // Could be column or function call
      const id = this.consume();
      if (this.peek().type === "PUNCT" && this.peek().value === "(") {
        this.consume(); // (
        const fnName = id.value.toUpperCase();
        let star = false;
        const args: Expr[] = [];
        if (this.peek().type === "STAR") {
          this.consume();
          star = true;
        } else if (
          !(this.peek().type === "PUNCT" && this.peek().value === ")")
        ) {
          args.push(this.parseExpr());
          while (this.accept("PUNCT", ",")) {
            args.push(this.parseExpr());
          }
        }
        const cl = this.peek();
        if (cl.type !== "PUNCT" || cl.value !== ")") {
          throw new ParseError(
            `expected ')' in function call, got ${describe(cl)}`,
            cl.pos,
          );
        }
        this.consume();
        return { type: "func", name: fnName, star, args };
      }
      // qualified column: id.id
      if (
        this.peek().type === "PUNCT" &&
        this.peek().value === "." &&
        this.peek(1).type === "IDENT"
      ) {
        this.consume(); // .
        const name = this.consume().value;
        return { type: "column", table: id.value, name };
      }
      return { type: "column", table: null, name: id.value };
    }
    throw new ParseError(`unexpected ${describe(t)}`, t.pos);
  }
}

function describe(t: Token): string {
  if (t.type === "EOF") return "end of input";
  return `${t.type} '${t.value}'`;
}

function defaultAlias(src: string): string {
  // Strip path components and trailing extension. e.g. "data/people.csv" -> "people"
  let base = src;
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (slash >= 0) base = base.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base;
}
