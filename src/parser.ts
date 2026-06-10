import { Token, TokenType, Lexer, ParseError } from './lexer';
import * as AST from './ast';

export class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  static parse(sql: string): AST.SelectStatement {
    const lexer = new Lexer(sql);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    return parser.parseSelect();
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    this.pos++;
    return tok;
  }

  private expect(type: TokenType): Token {
    if (this.peek().type !== type) {
      const tok = this.peek();
      throw new ParseError(
        `Expected ${type} but got ${tok.type} ('${tok.value}') at position ${tok.position}`,
        tok.position
      );
    }
    return this.advance();
  }

  private match(...types: TokenType[]): boolean {
    return types.includes(this.peek().type);
  }

  parseSelect(): AST.SelectStatement {
    this.expect(TokenType.SELECT);
    const columns = this.parseColumnList();
    this.expect(TokenType.FROM);
    const from = this.parseTableName();
    
    const joins: AST.JoinClause[] = [];
    while (this.match(TokenType.JOIN, TokenType.INNER)) {
      if (this.match(TokenType.INNER)) {
        this.advance();
      }
      this.expect(TokenType.JOIN);
      const joinTable = this.parseTableName();
      this.expect(TokenType.ON);
      const leftCol = this.parseColumnRef();
      this.expect(TokenType.EQ);
      const rightCol = this.parseColumnRef();
      joins.push({
        type: 'JoinClause',
        table: joinTable,
        leftCol,
        rightCol,
      });
    }

    let where: AST.ASTNode | undefined;
    if (this.match(TokenType.WHERE)) {
      this.advance();
      where = this.parseOr();
    }

    let groupBy: AST.ColumnRef[] | undefined;
    if (this.match(TokenType.GROUP)) {
      this.advance();
      this.expect(TokenType.BY);
      groupBy = [this.parseColumnRef()];
      while (this.match(TokenType.COMMA)) {
        this.advance();
        groupBy.push(this.parseColumnRef());
      }
    }

    let having: AST.ASTNode | undefined;
    if (this.match(TokenType.HAVING)) {
      this.advance();
      having = this.parseOr();
    }

    let orderBy: AST.OrderByItem[] | undefined;
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
      const tok = this.expect(TokenType.NUMBER);
      limit = tok.value as number;
    }

    let offset: number | undefined;
    if (this.match(TokenType.OFFSET)) {
      this.advance();
      const tok = this.expect(TokenType.NUMBER);
      offset = tok.value as number;
    }

    if (!this.match(TokenType.EOF)) {
      const tok = this.peek();
      throw new ParseError(
        `Unexpected token ${tok.type} ('${tok.value}') at position ${tok.position}`,
        tok.position
      );
    }

    return {
      type: 'SelectStatement',
      columns,
      from,
      joins: joins.length > 0 ? joins : undefined,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    };
  }

  private parseColumnList(): (AST.StarExpr | AST.ColumnRef | AST.AggregateExpr | { expr: AST.ASTNode; alias?: string })[] {
    const columns = [this.parseColumnItem()];
    while (this.match(TokenType.COMMA)) {
      this.advance();
      columns.push(this.parseColumnItem());
    }
    return columns;
  }

  private parseColumnItem(): AST.StarExpr | AST.ColumnRef | AST.AggregateExpr | { expr: AST.ASTNode; alias?: string } {
    const expr = this.parseAggregateOrExpr();
    let alias: string | undefined;
    if (this.match(TokenType.AS)) {
      this.advance();
      const tok = this.expect(TokenType.IDENTIFIER);
      alias = tok.value as string;
    }
    if (alias) {
      return { expr, alias };
    }
    return expr as AST.StarExpr | AST.ColumnRef | AST.AggregateExpr;
  }

  private parseAggregateOrExpr(): AST.ASTNode {
    if (this.match(TokenType.COUNT, TokenType.SUM, TokenType.AVG, TokenType.MIN, TokenType.MAX)) {
      const func = this.advance();
      this.expect(TokenType.LPAREN);
      let arg: AST.StarExpr | AST.ColumnRef;
      if (this.match(TokenType.STAR)) {
        this.advance();
        arg = { type: 'StarExpr' };
      } else {
        arg = this.parseColumnRef();
      }
      this.expect(TokenType.RPAREN);
      return {
        type: 'AggregateExpr',
        func: func.type as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX',
        arg,
      } as AST.AggregateExpr;
    }
    return this.parsePrimaryExpr();
  }

  private parseOrderByItem(): AST.OrderByItem {
    const expr = this.parsePrimaryExpr();
    let order: 'ASC' | 'DESC' = 'ASC';
    if (this.match(TokenType.ASC)) {
      this.advance();
    } else if (this.match(TokenType.DESC)) {
      this.advance();
      order = 'DESC';
    }
    return { type: 'OrderByItem', expr, order };
  }

  private parseOr(): AST.ASTNode {
    let left = this.parseAnd();
    while (this.match(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = { type: 'BinaryExpr', op: 'OR', left, right } as AST.BinaryExpr;
    }
    return left;
  }

  private parseAnd(): AST.ASTNode {
    let left = this.parseNot();
    while (this.match(TokenType.AND)) {
      this.advance();
      const right = this.parseNot();
      left = { type: 'BinaryExpr', op: 'AND', left, right } as AST.BinaryExpr;
    }
    return left;
  }

  private parseNot(): AST.ASTNode {
    if (this.match(TokenType.NOT)) {
      this.advance();
      const expr = this.parseNot();
      return { type: 'NotExpr', expr } as AST.NotExpr;
    }
    return this.parseComparison();
  }

  private parseComparison(): AST.ASTNode {
    let left = this.parsePrimaryExpr();
    while (
      this.match(TokenType.EQ, TokenType.NEQ, TokenType.LT, TokenType.LTE, TokenType.GT, TokenType.GTE) ||
      (this.match(TokenType.LIKE) && !this.isSelectContext())
    ) {
      if (this.match(TokenType.LIKE)) {
        this.advance();
        const patternTok = this.expect(TokenType.STRING);
        left = {
          type: 'LikeExpr',
          left,
          pattern: patternTok.value as string,
        } as AST.LikeExpr;
      } else {
        const op = this.advance();
        const right = this.parsePrimaryExpr();
        const opMap: Record<string, '=' | '!=' | '<' | '<=' | '>' | '>='> = {
          [TokenType.EQ]: '=',
          [TokenType.NEQ]: '!=',
          [TokenType.LT]: '<',
          [TokenType.LTE]: '<=',
          [TokenType.GT]: '>',
          [TokenType.GTE]: '>=',
        };
        left = {
          type: 'BinaryExpr',
          op: opMap[op.type],
          left,
          right,
        } as AST.BinaryExpr;
      }
    }
    return left;
  }

  private isSelectContext(): boolean {
    for (let i = this.pos; i < this.tokens.length; i++) {
      if (this.tokens[i].type === TokenType.FROM) return false;
      if (this.tokens[i].type === TokenType.WHERE) return true;
    }
    return false;
  }

  private parsePrimaryExpr(): AST.ASTNode {
    if (this.match(TokenType.LPAREN)) {
      this.advance();
      const expr = this.parseOr();
      this.expect(TokenType.RPAREN);
      return expr;
    }
    if (this.match(TokenType.COUNT, TokenType.SUM, TokenType.AVG, TokenType.MIN, TokenType.MAX)) {
      const func = this.advance();
      this.expect(TokenType.LPAREN);
      let arg: AST.StarExpr | AST.ColumnRef;
      if (this.match(TokenType.STAR)) {
        this.advance();
        arg = { type: 'StarExpr' };
      } else {
        arg = this.parseColumnRef();
      }
      this.expect(TokenType.RPAREN);
      return {
        type: 'AggregateExpr',
        func: func.type as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX',
        arg,
      } as AST.AggregateExpr;
    }
    if (this.match(TokenType.NUMBER)) {
      const tok = this.advance();
      return { type: 'LiteralExpr', value: tok.value as number } as AST.LiteralExpr;
    }
    if (this.match(TokenType.STRING)) {
      const tok = this.advance();
      return { type: 'LiteralExpr', value: tok.value as string } as AST.LiteralExpr;
    }
    if (this.match(TokenType.STAR)) {
      this.advance();
      return { type: 'StarExpr' } as AST.StarExpr;
    }
    return this.parseColumnRef();
  }

  private parseColumnRef(): AST.ColumnRef {
    const first = this.expect(TokenType.IDENTIFIER);
    let table: string | undefined;
    let name: string;
    if (this.match(TokenType.DOT)) {
      this.advance();
      if (this.match(TokenType.STAR)) {
        this.advance();
        return { type: 'ColumnRef', table: first.value as string, name: '*' };
      }
      const second = this.expect(TokenType.IDENTIFIER);
      table = first.value as string;
      name = second.value as string;
    } else {
      name = first.value as string;
    }
    return { type: 'ColumnRef', table, name };
  }

  private parseTableName(): string {
    const tok = this.expect(TokenType.IDENTIFIER);
    let name = tok.value as string;
    while (this.match(TokenType.DOT)) {
      this.advance();
      const next = this.peek();
      if (next.type === TokenType.IDENTIFIER) {
        const ext = this.advance();
        name += '.' + ext.value;
      } else {
        this.pos--;
        break;
      }
    }
    return name;
  }
}
