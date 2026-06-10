// SQL lexer - converts a SQL string into a stream of tokens.
// Supports identifiers (including dotted forms via the parser), numbers,
// single-quoted strings (with '' escape), operators and punctuation.

export type TokenType =
  | "IDENT"
  | "NUMBER"
  | "STRING"
  | "KEYWORD"
  | "OPERATOR"
  | "PUNCT"
  | "STAR"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  // 1-based for human-friendly errors
  pos: number;
}

export const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "GROUP",
  "HAVING",
  "AS",
  "INNER",
  "JOIN",
  "ON",
  "LIKE",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
]);

export class LexError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(`Lex error at position ${pos}: ${msg}`);
    this.pos = pos;
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // Skip whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    const startPos = i + 1;

    // String literal: single quotes, with '' escape
    if (ch === "'") {
      let s = "";
      i++; // consume opening quote
      let closed = false;
      while (i < n) {
        if (input[i] === "'") {
          if (i + 1 < n && input[i + 1] === "'") {
            s += "'";
            i += 2;
          } else {
            i++; // consume closing
            closed = true;
            break;
          }
        } else {
          s += input[i];
          i++;
        }
      }
      if (!closed) {
        throw new LexError("unterminated string literal", startPos);
      }
      tokens.push({ type: "STRING", value: s, pos: startPos });
      continue;
    }

    // Number: digits, optional decimal point, optional leading minus is handled
    // by the parser as a unary minus to keep the lexer simple (and so "a-1" works).
    if (ch >= "0" && ch <= "9") {
      let s = "";
      while (i < n && input[i] >= "0" && input[i] <= "9") {
        s += input[i];
        i++;
      }
      if (i < n && input[i] === ".") {
        s += ".";
        i++;
        while (i < n && input[i] >= "0" && input[i] <= "9") {
          s += input[i];
          i++;
        }
      }
      tokens.push({ type: "NUMBER", value: s, pos: startPos });
      continue;
    }

    // Identifier / keyword: letters, digits, underscore. May include '.' for
    // qualified column refs - we lex dot as PUNCT and let parser handle.
    if (isIdentStart(ch)) {
      let s = "";
      while (i < n && isIdentPart(input[i])) {
        s += input[i];
        i++;
      }
      const upper = s.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: "KEYWORD", value: upper, pos: startPos });
      } else {
        tokens.push({ type: "IDENT", value: s, pos: startPos });
      }
      continue;
    }

    // Multi-char operators
    if (ch === "<" || ch === ">" || ch === "!" || ch === "=") {
      const next = i + 1 < n ? input[i + 1] : "";
      if (ch === "<" && next === "=") {
        tokens.push({ type: "OPERATOR", value: "<=", pos: startPos });
        i += 2;
        continue;
      }
      if (ch === ">" && next === "=") {
        tokens.push({ type: "OPERATOR", value: ">=", pos: startPos });
        i += 2;
        continue;
      }
      if (ch === "!" && next === "=") {
        tokens.push({ type: "OPERATOR", value: "!=", pos: startPos });
        i += 2;
        continue;
      }
      if (ch === "<" && next === ">") {
        tokens.push({ type: "OPERATOR", value: "!=", pos: startPos });
        i += 2;
        continue;
      }
      if (ch === "=") {
        tokens.push({ type: "OPERATOR", value: "=", pos: startPos });
        i++;
        continue;
      }
      if (ch === "<") {
        tokens.push({ type: "OPERATOR", value: "<", pos: startPos });
        i++;
        continue;
      }
      if (ch === ">") {
        tokens.push({ type: "OPERATOR", value: ">", pos: startPos });
        i++;
        continue;
      }
      throw new LexError(`unexpected character '${ch}'`, startPos);
    }

    if (ch === "+" || ch === "-" || ch === "/" || ch === "%") {
      tokens.push({ type: "OPERATOR", value: ch, pos: startPos });
      i++;
      continue;
    }

    if (ch === "*") {
      tokens.push({ type: "STAR", value: "*", pos: startPos });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "," || ch === "." || ch === ";") {
      tokens.push({ type: "PUNCT", value: ch, pos: startPos });
      i++;
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, startPos);
  }

  tokens.push({ type: "EOF", value: "", pos: input.length + 1 });
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}
