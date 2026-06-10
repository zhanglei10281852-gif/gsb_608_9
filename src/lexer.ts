export enum TokenType {
  SELECT,
  FROM,
  WHERE,
  ORDER,
  BY,
  ASC,
  DESC,
  LIMIT,
  OFFSET,
  AS,
  AND,
  OR,
  NOT,
  LIKE,
  GROUP,
  HAVING,
  JOIN,
  INNER,
  ON,
  COUNT,
  SUM,
  AVG,
  MIN,
  MAX,
  STAR,
  IDENTIFIER,
  STRING,
  NUMBER,
  COMMA,
  DOT,
  LPAREN,
  RPAREN,
  EQ,
  NEQ,
  LT,
  LTE,
  GT,
  GTE,
  EOF,
}

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenType> = {
  SELECT: TokenType.SELECT,
  FROM: TokenType.FROM,
  WHERE: TokenType.WHERE,
  ORDER: TokenType.ORDER,
  BY: TokenType.BY,
  ASC: TokenType.ASC,
  DESC: TokenType.DESC,
  LIMIT: TokenType.LIMIT,
  OFFSET: TokenType.OFFSET,
  AS: TokenType.AS,
  AND: TokenType.AND,
  OR: TokenType.OR,
  NOT: TokenType.NOT,
  LIKE: TokenType.LIKE,
  GROUP: TokenType.GROUP,
  HAVING: TokenType.HAVING,
  JOIN: TokenType.JOIN,
  INNER: TokenType.INNER,
  ON: TokenType.ON,
  COUNT: TokenType.COUNT,
  SUM: TokenType.SUM,
  AVG: TokenType.AVG,
  MIN: TokenType.MIN,
  MAX: TokenType.MAX,
};

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: TokenType.LPAREN, value: "(", pos: i });
      i++;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: TokenType.RPAREN, value: ")", pos: i });
      i++;
      continue;
    }

    if (ch === ",") {
      tokens.push({ type: TokenType.COMMA, value: ",", pos: i });
      i++;
      continue;
    }

    if (ch === ".") {
      tokens.push({ type: TokenType.DOT, value: ".", pos: i });
      i++;
      continue;
    }

    if (ch === "*") {
      tokens.push({ type: TokenType.STAR, value: "*", pos: i });
      i++;
      continue;
    }

    if (ch === "=") {
      tokens.push({ type: TokenType.EQ, value: "=", pos: i });
      i++;
      continue;
    }

    if (ch === "!" && i + 1 < sql.length && sql[i + 1] === "=") {
      tokens.push({ type: TokenType.NEQ, value: "!=", pos: i });
      i += 2;
      continue;
    }

    if (ch === "<") {
      if (i + 1 < sql.length && sql[i + 1] === "=") {
        tokens.push({ type: TokenType.LTE, value: "<=", pos: i });
        i += 2;
      } else if (i + 1 < sql.length && sql[i + 1] === ">") {
        tokens.push({ type: TokenType.NEQ, value: "<>", pos: i });
        i += 2;
      } else {
        tokens.push({ type: TokenType.LT, value: "<", pos: i });
        i++;
      }
      continue;
    }

    if (ch === ">") {
      if (i + 1 < sql.length && sql[i + 1] === "=") {
        tokens.push({ type: TokenType.GTE, value: ">=", pos: i });
        i += 2;
      } else {
        tokens.push({ type: TokenType.GT, value: ">", pos: i });
        i++;
      }
      continue;
    }

    if (ch === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < sql.length && sql[i] !== "'") {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          i++;
          value += sql[i];
        } else {
          value += sql[i];
        }
        i++;
      }
      if (i >= sql.length) {
        throw new Error(
          `Lexical error: Unterminated string starting at position ${start}`,
        );
      }
      i++;
      tokens.push({ type: TokenType.STRING, value, pos: start });
      continue;
    }

    if (
      ch === "-" &&
      i + 1 < sql.length &&
      sql[i + 1] >= "0" &&
      sql[i + 1] <= "9"
    ) {
      const start = i;
      let num = "-";
      i++;
      while (
        i < sql.length &&
        ((sql[i] >= "0" && sql[i] <= "9") || sql[i] === ".")
      ) {
        num += sql[i];
        i++;
      }
      tokens.push({ type: TokenType.NUMBER, value: num, pos: start });
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      const start = i;
      let num = "";
      while (
        i < sql.length &&
        ((sql[i] >= "0" && sql[i] <= "9") || sql[i] === ".")
      ) {
        num += sql[i];
        i++;
      }
      tokens.push({ type: TokenType.NUMBER, value: num, pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      let ident = "";
      while (i < sql.length && isIdentPart(sql[i])) {
        ident += sql[i];
        i++;
      }
      const upper = ident.toUpperCase();
      if (upper in KEYWORDS) {
        tokens.push({ type: KEYWORDS[upper], value: upper, pos: start });
      } else {
        tokens.push({ type: TokenType.IDENTIFIER, value: ident, pos: start });
      }
      continue;
    }

    throw new Error(
      `Lexical error: Unexpected character '${ch}' at position ${i}`,
    );
  }

  tokens.push({ type: TokenType.EOF, value: "", pos: i });
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return (
    isIdentStart(ch) ||
    (ch >= "0" && ch <= "9") ||
    ch === "/" ||
    ch === "\\" ||
    ch === "."
  );
}
