export enum TokenType {
  SELECT = 'SELECT',
  FROM = 'FROM',
  WHERE = 'WHERE',
  ORDER = 'ORDER',
  BY = 'BY',
  ASC = 'ASC',
  DESC = 'DESC',
  LIMIT = 'LIMIT',
  OFFSET = 'OFFSET',
  GROUP = 'GROUP',
  HAVING = 'HAVING',
  JOIN = 'JOIN',
  INNER = 'INNER',
  ON = 'ON',
  AS = 'AS',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  LIKE = 'LIKE',
  IN = 'IN',
  COUNT = 'COUNT',
  SUM = 'SUM',
  AVG = 'AVG',
  MIN = 'MIN',
  MAX = 'MAX',
  STAR = 'STAR',
  COMMA = 'COMMA',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  EQ = 'EQ',
  NEQ = 'NEQ',
  LT = 'LT',
  LTE = 'LTE',
  GT = 'GT',
  GTE = 'GTE',
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  IDENTIFIER = 'IDENTIFIER',
  DOT = 'DOT',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string | number;
  position: number;
}

const KEYWORDS: Record<string, TokenType> = {
  'SELECT': TokenType.SELECT,
  'FROM': TokenType.FROM,
  'WHERE': TokenType.WHERE,
  'ORDER': TokenType.ORDER,
  'BY': TokenType.BY,
  'ASC': TokenType.ASC,
  'DESC': TokenType.DESC,
  'LIMIT': TokenType.LIMIT,
  'OFFSET': TokenType.OFFSET,
  'GROUP': TokenType.GROUP,
  'HAVING': TokenType.HAVING,
  'JOIN': TokenType.JOIN,
  'INNER': TokenType.INNER,
  'ON': TokenType.ON,
  'AS': TokenType.AS,
  'AND': TokenType.AND,
  'OR': TokenType.OR,
  'NOT': TokenType.NOT,
  'LIKE': TokenType.LIKE,
  'IN': TokenType.IN,
  'COUNT': TokenType.COUNT,
  'SUM': TokenType.SUM,
  'AVG': TokenType.AVG,
  'MIN': TokenType.MIN,
  'MAX': TokenType.MAX,
};

export class Lexer {
  private input: string;
  private pos: number;

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const char = this.input[this.pos];
      const start = this.pos;

      if (char === '*') {
        tokens.push({ type: TokenType.STAR, value: '*', position: start });
        this.pos++;
      } else if (char === ',') {
        tokens.push({ type: TokenType.COMMA, value: ',', position: start });
        this.pos++;
      } else if (char === '(') {
        tokens.push({ type: TokenType.LPAREN, value: '(', position: start });
        this.pos++;
      } else if (char === ')') {
        tokens.push({ type: TokenType.RPAREN, value: ')', position: start });
        this.pos++;
      } else if (char === '=') {
        tokens.push({ type: TokenType.EQ, value: '=', position: start });
        this.pos++;
      } else if (char === '!' && this.peek() === '=') {
        tokens.push({ type: TokenType.NEQ, value: '!=', position: start });
        this.pos += 2;
      } else if (char === '<' && this.peek() === '=') {
        tokens.push({ type: TokenType.LTE, value: '<=', position: start });
        this.pos += 2;
      } else if (char === '<') {
        tokens.push({ type: TokenType.LT, value: '<', position: start });
        this.pos++;
      } else if (char === '>' && this.peek() === '=') {
        tokens.push({ type: TokenType.GTE, value: '>=', position: start });
        this.pos += 2;
      } else if (char === '>') {
        tokens.push({ type: TokenType.GT, value: '>', position: start });
        this.pos++;
      } else if (char === '.') {
        tokens.push({ type: TokenType.DOT, value: '.', position: start });
        this.pos++;
      } else if (char === "'" || char === '"') {
        tokens.push(this.readString(char, start));
      } else if (this.isDigit(char) || (char === '-' && this.isDigit(this.peek()))) {
        tokens.push(this.readNumber(start));
      } else if (this.isAlpha(char) || char === '_') {
        tokens.push(this.readIdentifier(start));
      } else {
        throw new ParseError(`Unexpected character '${char}' at position ${start}`, start);
      }
    }
    tokens.push({ type: TokenType.EOF, value: '', position: this.pos });
    return tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++;
    }
  }

  private peek(): string {
    return this.pos + 1 < this.input.length ? this.input[this.pos + 1] : '';
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }

  private isAlpha(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  }

  private isAlphaNumeric(c: string): boolean {
    return this.isAlpha(c) || this.isDigit(c);
  }

  private isPathChar(c: string): boolean {
    return c === '/' || c === '\\' || c === '.' || c === '-' || c === '_' || this.isAlphaNumeric(c);
  }

  private readString(quote: string, start: number): Token {
    this.pos++;
    let value = '';
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c === quote) {
        if (this.peek() === quote) {
          value += quote;
          this.pos += 2;
        } else {
          this.pos++;
          return { type: TokenType.STRING, value, position: start };
        }
      } else {
        value += c;
        this.pos++;
      }
    }
    throw new ParseError(`Unterminated string starting at position ${start}`, start);
  }

  private readNumber(start: number): Token {
    let value = '';
    if (this.input[this.pos] === '-') {
      value += '-';
      this.pos++;
    }
    while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
      value += this.input[this.pos];
      this.pos++;
    }
    if (this.pos < this.input.length && this.input[this.pos] === '.' && this.isDigit(this.peek())) {
      value += '.';
      this.pos++;
      while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
        value += this.input[this.pos];
        this.pos++;
      }
    }
    return { type: TokenType.NUMBER, value: parseFloat(value), position: start };
  }

  private readIdentifier(start: number): Token {
    let value = '';
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (this.isAlphaNumeric(c) || c === '_' || c === '/' || c === '\\' || c === '-') {
        value += c;
        this.pos++;
      } else {
        break;
      }
    }
    const upper = value.toUpperCase();
    if (KEYWORDS[upper]) {
      return { type: KEYWORDS[upper], value: upper, position: start };
    }
    return { type: TokenType.IDENTIFIER, value, position: start };
  }
}

export class ParseError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
    this.name = 'ParseError';
  }
}
