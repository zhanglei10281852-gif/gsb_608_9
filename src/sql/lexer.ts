export type TokenType =
  | 'select'
  | 'from'
  | 'where'
  | 'group'
  | 'by'
  | 'having'
  | 'order'
  | 'limit'
  | 'offset'
  | 'asc'
  | 'desc'
  | 'and'
  | 'or'
  | 'not'
  | 'like'
  | 'inner'
  | 'join'
  | 'on'
  | 'as'
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'identifier'
  | 'string'
  | 'number'
  | 'star'
  | 'plus'
  | 'minus'
  | 'comma'
  | 'dot'
  | 'lparen'
  | 'rparen'
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'semicolon'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  position: number;
  line: number;
  column: number;
}

const KEYWORDS: Record<string, TokenType> = {
  select: 'select',
  from: 'from',
  where: 'where',
  group: 'group',
  by: 'by',
  having: 'having',
  order: 'order',
  limit: 'limit',
  offset: 'offset',
  asc: 'asc',
  desc: 'desc',
  and: 'and',
  or: 'or',
  not: 'not',
  like: 'like',
  inner: 'inner',
  join: 'join',
  on: 'on',
  as: 'as',
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
};

export class Lexer {
  private input: string;
  private position = 0;
  private line = 1;
  private column = 1;

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.position < this.input.length) {
      this.skipWhitespaceAndComments();

      if (this.position >= this.input.length) {
        break;
      }

      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }

    tokens.push({
      type: 'eof',
      value: '',
      position: this.position,
      line: this.line,
      column: this.column,
    });

    return tokens;
  }

  private skipWhitespaceAndComments(): void {
    while (this.position < this.input.length) {
      const char = this.input[this.position];

      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        this.advance();
      } else if (char === '-' && this.input[this.position + 1] === '-') {
        while (this.position < this.input.length && this.input[this.position] !== '\n') {
          this.advance();
        }
      } else if (char === '/' && this.input[this.position + 1] === '*') {
        this.advance();
        this.advance();
        while (
          this.position < this.input.length &&
          !(this.input[this.position] === '*' && this.input[this.position + 1] === '/')
        ) {
          this.advance();
        }
        if (this.position < this.input.length) {
          this.advance();
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private nextToken(): Token | null {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    const char = this.input[this.position];

    if (char === "'" || char === '"') {
      return this.readString(char);
    }

    if (this.isDigit(char) || (char === '.' && this.isDigit(this.input[this.position + 1]))) {
      return this.readNumber();
    }

    if (this.isIdentifierStart(char)) {
      return this.readIdentifier();
    }

    switch (char) {
      case '*':
        this.advance();
        return { type: 'star', value: '*', position: startPos, line: startLine, column: startColumn };
      case '+':
        this.advance();
        return { type: 'plus', value: '+', position: startPos, line: startLine, column: startColumn };
      case '-':
        this.advance();
        return { type: 'minus', value: '-', position: startPos, line: startLine, column: startColumn };
      case ',':
        this.advance();
        return { type: 'comma', value: ',', position: startPos, line: startLine, column: startColumn };
      case '.':
        this.advance();
        return { type: 'dot', value: '.', position: startPos, line: startLine, column: startColumn };
      case '(':
        this.advance();
        return { type: 'lparen', value: '(', position: startPos, line: startLine, column: startColumn };
      case ')':
        this.advance();
        return { type: 'rparen', value: ')', position: startPos, line: startLine, column: startColumn };
      case ';':
        this.advance();
        return { type: 'semicolon', value: ';', position: startPos, line: startLine, column: startColumn };
      case '=':
        this.advance();
        return { type: 'eq', value: '=', position: startPos, line: startLine, column: startColumn };
      case '!':
        if (this.input[this.position + 1] === '=') {
          this.advance();
          this.advance();
          return { type: 'neq', value: '!=', position: startPos, line: startLine, column: startColumn };
        }
        throw new SyntaxError(`Unexpected character '!' at line ${this.line}, column ${this.column}`);
      case '<':
        this.advance();
        if (this.input[this.position] === '=') {
          this.advance();
          return { type: 'lte', value: '<=', position: startPos, line: startLine, column: startColumn };
        }
        return { type: 'lt', value: '<', position: startPos, line: startLine, column: startColumn };
      case '>':
        this.advance();
        if (this.input[this.position] === '=') {
          this.advance();
          return { type: 'gte', value: '>=', position: startPos, line: startLine, column: startColumn };
        }
        return { type: 'gt', value: '>', position: startPos, line: startLine, column: startColumn };
      default:
        throw new SyntaxError(`Unexpected character '${char}' at line ${this.line}, column ${this.column}`);
    }
  }

  private readString(quote: string): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let value = '';

    this.advance();

    while (this.position < this.input.length) {
      const char = this.input[this.position];

      if (char === quote) {
        if (this.input[this.position + 1] === quote) {
          value += quote;
          this.advance();
          this.advance();
        } else {
          this.advance();
          break;
        }
      } else {
        value += char;
        this.advance();
      }
    }

    return { type: 'string', value, position: startPos, line: startLine, column: startColumn };
  }

  private readNumber(): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let value = '';
    let hasDot = false;

    while (this.position < this.input.length) {
      const char = this.input[this.position];

      if (this.isDigit(char)) {
        value += char;
        this.advance();
      } else if (char === '.' && !hasDot) {
        value += char;
        hasDot = true;
        this.advance();
      } else {
        break;
      }
    }

    return { type: 'number', value, position: startPos, line: startLine, column: startColumn };
  }

  private readIdentifier(): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let value = '';

    while (this.position < this.input.length) {
      const char = this.input[this.position];

      if (this.isIdentifierChar(char)) {
        value += char;
        this.advance();
      } else {
        break;
      }
    }

    const lowerValue = value.toLowerCase();
    const keywordType = KEYWORDS[lowerValue];

    if (keywordType) {
      return { type: keywordType, value: lowerValue, position: startPos, line: startLine, column: startColumn };
    }

    return { type: 'identifier', value, position: startPos, line: startLine, column: startColumn };
  }

  private advance(): void {
    if (this.input[this.position] === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.position++;
  }

  private isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
  }

  private isIdentifierStart(char: string): boolean {
    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
  }

  private isIdentifierChar(char: string): boolean {
    return this.isIdentifierStart(char) || this.isDigit(char);
  }
}

export function tokenize(input: string): Token[] {
  const lexer = new Lexer(input);
  return lexer.tokenize();
}
