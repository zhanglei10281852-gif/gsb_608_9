import { Token, TokenType, tokenize } from "./lexer";

export type Expr =
  | { type: "literal"; value: string | number; dataType: "string" | "number" }
  | { type: "column"; table?: string; name: string }
  | { type: "star"; table?: string }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "unary"; op: string; operand: Expr }
  | { type: "like"; expr: Expr; pattern: string }
  | {
      type: "aggregate";
      func: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
      arg: Expr;
      distinct?: boolean;
    }
  | { type: "is_null"; expr: Expr; negated: boolean };

export interface SelectColumn {
  expr: Expr;
  alias?: string;
}

export interface OrderByItem {
  expr: Expr;
  direction: "ASC" | "DESC";
}

export interface JoinClause {
  table: string;
  alias?: string;
  on: Expr;
}

export interface SelectStatement {
  type: "select";
  columns: SelectColumn[];
  from: string;
  fromAlias?: string;
  join?: JoinClause;
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
}

export function parse(sql: string): SelectStatement {
  const tokens = tokenize(sql);
  const parser = new Parser(tokens);
  return parser.parseSelect();
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new Error(
        `Parse error at position ${t.pos}: Expected ${TokenType[type]}${value ? ` '${value}'` : ""} but got ${TokenType[t.type]} '${t.value}'`,
      );
    }
    if (value !== undefined && t.value.toUpperCase() !== value.toUpperCase()) {
      throw new Error(
        `Parse error at position ${t.pos}: Expected '${value}' but got '${t.value}'`,
      );
    }
    return this.advance();
  }

  private match(type: TokenType, value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value.toUpperCase() !== value.toUpperCase())
      return false;
    return true;
  }

  parseSelect(): SelectStatement {
    this.expect(TokenType.SELECT);

    const columns = this.parseSelectColumns();

    this.expect(TokenType.FROM);
    const fromToken = this.expect(TokenType.IDENTIFIER);
    const from = fromToken.value;

    let fromAlias: string | undefined;
    if (this.match(TokenType.AS)) {
      this.advance();
      fromAlias = this.expect(TokenType.IDENTIFIER).value;
    } else if (
      this.match(TokenType.IDENTIFIER) &&
      !this.isKeyword(this.peek().value)
    ) {
      fromAlias = this.advance().value;
    }

    let join: JoinClause | undefined;
    if (this.match(TokenType.INNER)) {
      this.advance();
    }
    if (this.match(TokenType.JOIN)) {
      this.advance();
      const joinTable = this.expect(TokenType.IDENTIFIER).value;
      let joinAlias: string | undefined;
      if (this.match(TokenType.AS)) {
        this.advance();
        joinAlias = this.expect(TokenType.IDENTIFIER).value;
      } else if (
        this.match(TokenType.IDENTIFIER) &&
        !this.isKeyword(this.peek().value)
      ) {
        joinAlias = this.advance().value;
      }
      this.expect(TokenType.ON);
      const onExpr = this.parseExpr();
      join = { table: joinTable, alias: joinAlias, on: onExpr };
    }

    let where: Expr | undefined;
    if (this.match(TokenType.WHERE)) {
      this.advance();
      where = this.parseExpr();
    }

    let groupBy: Expr[] | undefined;
    if (this.match(TokenType.GROUP)) {
      this.advance();
      this.expect(TokenType.BY);
      groupBy = [this.parseExpr()];
      while (this.match(TokenType.COMMA)) {
        this.advance();
        groupBy.push(this.parseExpr());
      }
    }

    let having: Expr | undefined;
    if (this.match(TokenType.HAVING)) {
      this.advance();
      having = this.parseExpr();
    }

    let orderBy: OrderByItem[] | undefined;
    if (this.match(TokenType.ORDER)) {
      this.advance();
      this.expect(TokenType.BY);
      orderBy = [this.parseOrderByItem()];
      while (this.match(TokenType.COMMA)) {
        this.advance();
        orderBy.push(this.parseOrderByItem());
      }
    }

    let limit: number | undefined;
    if (this.match(TokenType.LIMIT)) {
      this.advance();
      limit = parseInt(this.expect(TokenType.NUMBER).value, 10);
    }

    let offset: number | undefined;
    if (this.match(TokenType.OFFSET)) {
      this.advance();
      offset = parseInt(this.expect(TokenType.NUMBER).value, 10);
    }

    if (this.peek().type !== TokenType.EOF) {
      const t = this.peek();
      throw new Error(
        `Parse error at position ${t.pos}: Unexpected token ${TokenType[t.type]} '${t.value}'`,
      );
    }

    return {
      type: "select",
      columns,
      from,
      fromAlias,
      join,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    };
  }

  private parseSelectColumns(): SelectColumn[] {
    const cols: SelectColumn[] = [];

    if (this.match(TokenType.STAR)) {
      this.advance();
      cols.push({ expr: { type: "star" } });
      return cols;
    }

    cols.push(this.parseSelectColumn());
    while (this.match(TokenType.COMMA)) {
      this.advance();
      cols.push(this.parseSelectColumn());
    }
    return cols;
  }

  private parseSelectColumn(): SelectColumn {
    const expr = this.parseExpr();
    let alias: string | undefined;
    if (this.match(TokenType.AS)) {
      this.advance();
      alias = this.expect(TokenType.IDENTIFIER).value;
    } else if (
      this.match(TokenType.IDENTIFIER) &&
      !this.isKeyword(this.peek().value)
    ) {
      alias = this.advance().value;
    }
    return { expr, alias };
  }

  private parseOrderByItem(): OrderByItem {
    const expr = this.parseExpr();
    let direction: "ASC" | "DESC" = "ASC";
    if (this.match(TokenType.ASC)) {
      this.advance();
      direction = "ASC";
    } else if (this.match(TokenType.DESC)) {
      this.advance();
      direction = "DESC";
    }
    return { expr, direction };
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.match(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = { type: "binary", op: "OR", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.match(TokenType.AND)) {
      this.advance();
      const right = this.parseNot();
      left = { type: "binary", op: "AND", left, right };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.match(TokenType.NOT)) {
      this.advance();
      const operand = this.parseNot();
      return { type: "unary", op: "NOT", operand };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAddition();

    const compOps: TokenType[] = [
      TokenType.EQ,
      TokenType.NEQ,
      TokenType.LT,
      TokenType.LTE,
      TokenType.GT,
      TokenType.GTE,
    ];
    const t = this.peek();

    if (compOps.includes(t.type)) {
      const op = this.advance().value;
      const right = this.parseAddition();
      return { type: "binary", op, left, right };
    }

    if (this.match(TokenType.LIKE)) {
      this.advance();
      const patternToken = this.expect(TokenType.STRING);
      return { type: "like", expr: left, pattern: patternToken.value };
    }

    if (this.match(TokenType.NOT)) {
      const saved = this.pos;
      this.advance();
      if (this.match(TokenType.LIKE)) {
        this.advance();
        const patternToken = this.expect(TokenType.STRING);
        return {
          type: "unary",
          op: "NOT",
          operand: { type: "like", expr: left, pattern: patternToken.value },
        };
      }
      this.pos = saved;
    }

    return left;
  }

  private parseAddition(): Expr {
    let left = this.parseMultiplication();
    while (
      this.peek().type === TokenType.IDENTIFIER &&
      (this.peek().value === "+" || this.peek().value === "-")
    ) {
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplication(): Expr {
    let left = this.parsePrimary();
    while (
      this.peek().type === TokenType.IDENTIFIER &&
      (this.peek().value === "*" || this.peek().value === "/")
    ) {
      const op = this.advance().value;
      const right = this.parsePrimary();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === TokenType.NUMBER) {
      this.advance();
      const num = parseFloat(t.value);
      return { type: "literal", value: num, dataType: "number" };
    }

    if (t.type === TokenType.STRING) {
      this.advance();
      return { type: "literal", value: t.value, dataType: "string" };
    }

    if (t.type === TokenType.LPAREN) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    const aggFuncs: TokenType[] = [
      TokenType.COUNT,
      TokenType.SUM,
      TokenType.AVG,
      TokenType.MIN,
      TokenType.MAX,
    ];
    if (aggFuncs.includes(t.type)) {
      const func = this.advance().value as
        | "COUNT"
        | "SUM"
        | "AVG"
        | "MIN"
        | "MAX";
      this.expect(TokenType.LPAREN);

      if (this.match(TokenType.STAR)) {
        this.advance();
        this.expect(TokenType.RPAREN);
        return { type: "aggregate", func, arg: { type: "star" } };
      }

      let distinct = false;
      if (
        this.match(TokenType.IDENTIFIER) &&
        this.peek().value.toUpperCase() === "DISTINCT"
      ) {
        this.advance();
        distinct = true;
      }

      const arg = this.parseExpr();
      this.expect(TokenType.RPAREN);
      return { type: "aggregate", func, arg, distinct };
    }

    if (t.type === TokenType.IDENTIFIER) {
      this.advance();
      if (t.value.includes(".")) {
        const dotIndex = t.value.lastIndexOf(".");
        const table = t.value.substring(0, dotIndex);
        const name = t.value.substring(dotIndex + 1);
        if (name === "*") {
          return { type: "star", table };
        }
        return { type: "column", table, name };
      }
      if (this.match(TokenType.DOT)) {
        this.advance();
        const next = this.peek();
        if (next.type === TokenType.STAR) {
          this.advance();
          return { type: "star", table: t.value };
        }
        const col = this.expect(TokenType.IDENTIFIER).value;
        return { type: "column", table: t.value, name: col };
      }
      return { type: "column", name: t.value };
    }

    if (t.type === TokenType.STAR) {
      this.advance();
      return { type: "star" };
    }

    throw new Error(
      `Parse error at position ${t.pos}: Unexpected token ${TokenType[t.type]} '${t.value}'`,
    );
  }

  private isKeyword(value: string): boolean {
    const keywords = [
      "SELECT",
      "FROM",
      "WHERE",
      "ORDER",
      "BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "AS",
      "AND",
      "OR",
      "NOT",
      "LIKE",
      "GROUP",
      "HAVING",
      "JOIN",
      "INNER",
      "ON",
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
    ];
    return keywords.includes(value.toUpperCase());
  }
}
