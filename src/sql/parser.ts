import { Token, TokenType } from './lexer';
import {
  SelectStatement,
  SelectColumn,
  TableRef,
  JoinClause,
  OrderByItem,
  Expression,
  LiteralExpression,
  ColumnExpression,
  BinaryExpression,
  UnaryExpression,
  FunctionCallExpression,
  WildcardExpression,
  BinaryOperator,
} from './ast';

export class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): SelectStatement {
    const statement = this.parseSelect();
    if (this.check('semicolon')) {
      this.advance();
    }
    if (!this.isAtEnd()) {
      throw this.createError('Unexpected token after statement');
    }
    return statement;
  }

  parseSelect(): SelectStatement {
    this.expect('select');

    const columns = this.parseSelectColumns();
    this.expect('from');
    const from = this.parseTableRef();

    const joins: JoinClause[] = [];
    while (this.check('inner') || this.check('join')) {
      joins.push(this.parseJoin());
    }

    let where: Expression | undefined;
    if (this.check('where')) {
      this.advance();
      where = this.parseExpression();
    }

    let groupBy: string[] | undefined;
    if (this.check('group')) {
      this.advance();
      this.expect('by');
      groupBy = this.parseIdentifierList();
    }

    let having: Expression | undefined;
    if (this.check('having')) {
      this.advance();
      having = this.parseExpression();
    }

    let orderBy: OrderByItem[] | undefined;
    if (this.check('order')) {
      this.advance();
      this.expect('by');
      orderBy = this.parseOrderBy();
    }

    let limit: number | undefined;
    if (this.check('limit')) {
      this.advance();
      const limitToken = this.expect('number');
      limit = parseInt(limitToken.value, 10);
    }

    let offset: number | undefined;
    if (this.check('offset')) {
      this.advance();
      const offsetToken = this.expect('number');
      offset = parseInt(offsetToken.value, 10);
    }

    return {
      type: 'select',
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

  private parseSelectColumns(): SelectColumn[] {
    const columns: SelectColumn[] = [];

    do {
      columns.push(this.parseSelectColumn());
    } while (this.match('comma'));

    return columns;
  }

  private parseSelectColumn(): SelectColumn {
    const expression = this.parseExpression();

    let alias: string | undefined;
    if (this.match('as')) {
      const aliasToken = this.expect('identifier');
      alias = aliasToken.value;
    } else if (this.check('identifier') && !this.isFollowedByKeyword()) {
      const aliasToken = this.advance();
      alias = aliasToken.value;
    }

    return { expression, alias };
  }

  private isFollowedByKeyword(): boolean {
    const next = this.peek();
    const keywords: TokenType[] = [
      'from', 'where', 'group', 'order', 'limit', 'offset', 'having',
      'inner', 'join', 'and', 'or', 'as', 'comma', 'semicolon', 'eof'
    ];
    return keywords.includes(next.type);
  }

  private parseTableRef(): TableRef {
    let tableName = '';
    
    const firstToken = this.expect('identifier');
    tableName = firstToken.value;

    while (this.check('dot')) {
      this.advance();
      const nextToken = this.expect('identifier');
      tableName += '.' + nextToken.value;
    }

    let alias: string | undefined;
    if (this.match('as')) {
      const aliasToken = this.expect('identifier');
      alias = aliasToken.value;
    } else if (this.check('identifier') && !this.isJoinKeyword()) {
      const aliasToken = this.advance();
      alias = aliasToken.value;
    }

    return { tableName, alias };
  }

  private isJoinKeyword(): boolean {
    const next = this.peek();
    return ['inner', 'join', 'where', 'group', 'order', 'limit', 'offset', 'having', 'semicolon', 'eof'].includes(next.type);
  }

  private parseJoin(): JoinClause {
    if (this.check('inner')) {
      this.advance();
    }
    this.expect('join');

    const table = this.parseTableRef();

    this.expect('on');
    const on = this.parseExpression();

    return { type: 'inner', table, on };
  }

  private parseIdentifierList(): string[] {
    const identifiers: string[] = [];

    do {
      const token = this.expect('identifier');
      identifiers.push(token.value);
    } while (this.match('comma'));

    return identifiers;
  }

  private parseOrderBy(): OrderByItem[] {
    const items: OrderByItem[] = [];

    do {
      const expression = this.parseExpression();
      let direction: 'asc' | 'desc' = 'asc';

      if (this.match('asc')) {
        direction = 'asc';
      } else if (this.match('desc')) {
        direction = 'desc';
      }

      items.push({ expression, direction });
    } while (this.match('comma'));

    return items;
  }

  private parseExpression(): Expression {
    return this.parseOr();
  }

  private parseOr(): Expression {
    let left = this.parseAnd();

    while (this.match('or')) {
      const operator: BinaryOperator = 'or';
      const right = this.parseAnd();
      left = { type: 'binary', operator, left, right } as BinaryExpression;
    }

    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseNot();

    while (this.match('and')) {
      const operator: BinaryOperator = 'and';
      const right = this.parseNot();
      left = { type: 'binary', operator, left, right } as BinaryExpression;
    }

    return left;
  }

  private parseNot(): Expression {
    if (this.match('not')) {
      const operand = this.parseNot();
      return { type: 'unary', operator: 'not', operand } as UnaryExpression;
    }
    return this.parseComparison();
  }

  private parseComparison(): Expression {
    let left = this.parseAdditive();

    while (true) {
      if (this.match('eq')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '=', left, right } as BinaryExpression;
      } else if (this.match('neq')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '!=', left, right } as BinaryExpression;
      } else if (this.match('lt')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '<', left, right } as BinaryExpression;
      } else if (this.match('lte')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '<=', left, right } as BinaryExpression;
      } else if (this.match('gt')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '>', left, right } as BinaryExpression;
      } else if (this.match('gte')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: '>=', left, right } as BinaryExpression;
      } else if (this.match('like')) {
        const right = this.parseAdditive();
        left = { type: 'binary', operator: 'like', left, right } as BinaryExpression;
      } else {
        break;
      }
    }

    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();

    while (true) {
      if (this.match('plus')) {
        const right = this.parseMultiplicative();
        left = { type: 'binary', operator: '+', left, right } as BinaryExpression;
      } else if (this.match('minus')) {
        const right = this.parseMultiplicative();
        left = { type: 'binary', operator: '-', left, right } as BinaryExpression;
      } else {
        break;
      }
    }

    return left;
  }

  private parseMultiplicative(): Expression {
    return this.parseUnary();
  }

  private parseUnary(): Expression {
    if (this.match('minus')) {
      const operand = this.parseUnary();
      return { type: 'unary', operator: '-', operand } as UnaryExpression;
    }
    if (this.match('plus')) {
      const operand = this.parseUnary();
      return { type: 'unary', operator: '+', operand } as UnaryExpression;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    if (this.match('lparen')) {
      const expression = this.parseExpression();
      this.expect('rparen');
      return expression;
    }

    if (this.check('number')) {
      const token = this.advance();
      return {
        type: 'literal',
        value: parseFloat(token.value),
        valueType: 'number',
      } as LiteralExpression;
    }

    if (this.check('string')) {
      const token = this.advance();
      return {
        type: 'literal',
        value: token.value,
        valueType: 'string',
      } as LiteralExpression;
    }

    if (this.check('star')) {
      const token = this.advance();
      return { type: 'wildcard' } as WildcardExpression;
    }

    if (this.check('identifier') || this.isFunctionKeyword()) {
      const next = this.peekNext();

      if (next.type === 'lparen') {
        return this.parseFunctionCall();
      }

      if (this.check('identifier')) {
        return this.parseColumn();
      }
    }

    throw this.createError('Expected expression');
  }

  private parseColumn(): Expression {
    const first = this.expect('identifier');

    if (this.match('dot')) {
      const second = this.expect('identifier');
      if (second.type === 'star') {
        return { type: 'wildcard', tableName: first.value } as WildcardExpression;
      }
      return {
        type: 'column',
        tableName: first.value,
        columnName: second.value,
      } as ColumnExpression;
    }

    if (this.match('star')) {
      throw this.createError('Unexpected star');
    }

    return { type: 'column', columnName: first.value } as ColumnExpression;
  }

  private isFunctionKeyword(): boolean {
    const token = this.peek();
    return ['count', 'sum', 'avg', 'min', 'max'].includes(token.type);
  }

  private parseFunctionCall(): FunctionCallExpression {
    let functionName: string;
    
    if (this.isFunctionKeyword()) {
      const token = this.advance();
      functionName = token.value.toLowerCase();
    } else {
      const functionNameToken = this.expect('identifier');
      functionName = functionNameToken.value.toLowerCase();
    }

    this.expect('lparen');

    const args: Expression[] = [];

    if (!this.check('rparen')) {
      do {
        args.push(this.parseExpression());
      } while (this.match('comma'));
    }

    this.expect('rparen');

    return {
      type: 'function',
      functionName,
      arguments: args,
    } as FunctionCallExpression;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.position++;
    }
    return this.previous();
  }

  private previous(): Token {
    return this.tokens[this.position - 1];
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private peekNext(): Token {
    if (this.position + 1 < this.tokens.length) {
      return this.tokens[this.position + 1];
    }
    return this.tokens[this.tokens.length - 1];
  }

  private isAtEnd(): boolean {
    return this.peek().type === 'eof';
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }
    throw this.createError(`Expected ${type}, got ${this.peek().type}`);
  }

  private createError(message: string): SyntaxError {
    const token = this.peek();
    return new SyntaxError(`${message} at line ${token.line}, column ${token.column} (token: '${token.value}')`);
  }
}

export function parseSQL(sql: string): SelectStatement {
  const { tokenize } = require('./lexer');
  const tokens = tokenize(sql);
  const parser = new Parser(tokens);
  return parser.parse();
}
