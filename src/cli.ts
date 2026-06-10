#!/usr/bin/env node
// CLI entry point.
//
// Usage:
//   csvsql-mini -q "SQL" [--format csv|json|table] [--stdin-as NAME] [-h]
//
// Tables in the FROM/JOIN clauses are resolved as follows:
//   1. If the source matches the value passed via --stdin-as (default "stdin"),
//      data is read from process.stdin.
//   2. Otherwise the source is treated as a file path. If the path has no
//      extension and a sibling file with ".csv" exists, that file is used.

import * as fs from "fs";

import { parseCsv, ParsedCsv } from "./csv";
import { parse, ParseError } from "./parser";
import { LexError } from "./lexer";
import { execute, ExecError, formatResult, TableLoader } from "./executor";

interface CliArgs {
  query: string | null;
  queryFile: string | null;
  format: "csv" | "json" | "table";
  stdinAs: string;
  help: boolean;
}

const HELP = `csvsql-mini - run SQL against CSV files

USAGE:
  csvsql-mini -q "<sql>" [--format csv|json|table]
  csvsql-mini -f query.sql [--format csv|json|table]
  cat data.csv | csvsql-mini -q "SELECT * FROM stdin LIMIT 3"

OPTIONS:
  -q, --query <sql>     SQL query string
  -f, --file  <path>    Read SQL query from a file
      --format <fmt>    Output format: csv (default) | json | table
      --stdin-as <name> Table name used to refer to standard input
                        (default: "stdin")
  -h, --help            Show this help

SQL SUBSET:
  SELECT col [AS alias], ... | *
  FROM <file.csv> [alias]
  [INNER] JOIN <file.csv> [alias] ON <equality>
  WHERE <expr>           comparison: = != < <= > >=, AND OR NOT, parentheses,
                                       LIKE ('%' and '_' wildcards)
  GROUP BY col, ...
  HAVING <expr>
  ORDER BY <expr> [ASC|DESC], ...
  LIMIT n [OFFSET n]

  Aggregates: COUNT(*), COUNT(col), SUM(col), AVG(col), MIN(col), MAX(col)
`;

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    query: null,
    queryFile: null,
    format: "csv",
    stdinAs: "stdin",
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
    } else if (a === "-q" || a === "--query") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`option ${a} requires a value`);
      out.query = v;
      i += 2;
    } else if (a === "-f" || a === "--file") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`option ${a} requires a value`);
      out.queryFile = v;
      i += 2;
    } else if (a === "--format") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`option --format requires a value`);
      if (v !== "csv" && v !== "json" && v !== "table") {
        throw new Error(`unknown format '${v}', expected csv|json|table`);
      }
      out.format = v;
      i += 2;
    } else if (a === "--stdin-as") {
      const v = argv[i + 1];
      if (v === undefined)
        throw new Error(`option --stdin-as requires a value`);
      out.stdinAs = v;
      i += 2;
    } else {
      throw new Error(`unknown option '${a}'`);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.stderr.write(`Use --help for usage.\n`);
    return 2;
  }

  if (args.help || (!args.query && !args.queryFile)) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }

  let sql: string;
  if (args.query) {
    sql = args.query;
  } else {
    try {
      sql = fs.readFileSync(args.queryFile!, "utf8");
    } catch (err) {
      process.stderr.write(
        `error: cannot read query file '${args.queryFile}': ${(err as Error).message}\n`,
      );
      return 2;
    }
  }

  // Parse SQL
  let query;
  try {
    query = parse(sql);
  } catch (err) {
    if (err instanceof LexError || err instanceof ParseError) {
      process.stderr.write(`error: ${err.message}\n`);
      // Show indicator
      const pos = (err as any).pos as number;
      if (pos && pos <= sql.length + 1) {
        process.stderr.write(`  ${sql}\n`);
        process.stderr.write(`  ${" ".repeat(Math.max(0, pos - 1))}^\n`);
      }
      return 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Cache for stdin (only read once)
  let stdinParsed: ParsedCsv | null = null;

  const loader: TableLoader = async (source: string) => {
    if (source === args.stdinAs) {
      if (stdinParsed) return stdinParsed;
      const text = await readStdin();
      stdinParsed = parseCsv(text);
      return stdinParsed;
    }
    // Try as file path; if extension missing and "<name>.csv" exists, use it.
    let filePath = source;
    if (!fs.existsSync(filePath)) {
      const withExt = source + ".csv";
      if (fs.existsSync(withExt)) {
        filePath = withExt;
      } else {
        throw new ExecError(`table source not found: '${source}'`);
      }
    }
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      throw new ExecError(
        `cannot read '${filePath}': ${(err as Error).message}`,
      );
    }
    return parseCsv(text);
  };

  try {
    const result = await execute(query, loader);
    const out = formatResult(result, args.format);
    process.stdout.write(out);
    return 0;
  } catch (err) {
    if (err instanceof ExecError) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    return 1;
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`fatal: ${(err && err.message) || err}\n`);
    process.exit(1);
  },
);
