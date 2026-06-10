#!/usr/bin/env node

import { parse } from "./parser";
import { execute, loadTableFromFile, loadTableFromStdin } from "./executor";
import { toCsv, toJson, toTable, CsvTable } from "./csv";
import * as path from "path";

const HELP_TEXT = `
csvsql - Run SQL queries on CSV files

USAGE:
  node dist/cli.js -q "<SQL>" [options]

OPTIONS:
  -q, --query <SQL>       SQL query to execute (required)
  -f, --format <format>   Output format: csv (default), json, table
  -h, --help              Show this help message

SUPPORTED SQL:
  SELECT columns, *, expressions, AS aliases
  FROM table.csv
  [INNER] JOIN table2.csv ON condition
  WHERE condition (=, !=, <, <=, >, >=, AND, OR, NOT, LIKE, parentheses)
  GROUP BY columns
  HAVING condition
  ORDER BY columns [ASC|DESC]
  LIMIT n OFFSET m

  Aggregate functions: COUNT(*), COUNT(col), SUM, AVG, MIN, MAX

EXAMPLES:
  node dist/cli.js -q "SELECT * FROM people.csv"
  node dist/cli.js -q "SELECT name, age FROM people.csv WHERE age >= 18 ORDER BY age DESC"
  node dist/cli.js -q "SELECT department, COUNT(*) AS cnt, AVG(salary) AS avg_sal FROM employees.csv GROUP BY department HAVING COUNT(*) > 1"
  node dist/cli.js -q "SELECT e.name, d.dept_name FROM employees.csv INNER JOIN departments.csv ON e.dept_id = d.id"
  cat data.csv | node dist/cli.js -q "SELECT * FROM stdin WHERE value > 100"

NOTES:
  - CSV file names in SQL are used as table names (with or without .csv extension)
  - Numeric columns are automatically detected for proper number comparison
  - LIKE supports % (any sequence) and _ (single character) wildcards
`;

interface CliArgs {
  query: string;
  format: "csv" | "json" | "table";
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    query: "",
    format: "csv",
    help: false,
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      i++;
    } else if (arg === "-q" || arg === "--query") {
      i++;
      if (i >= argv.length) {
        errorExit("Missing value for --query option");
      }
      args.query = argv[i];
      i++;
    } else if (arg === "-f" || arg === "--format") {
      i++;
      if (i >= argv.length) {
        errorExit("Missing value for --format option");
      }
      const fmt = argv[i].toLowerCase();
      if (fmt !== "csv" && fmt !== "json" && fmt !== "table") {
        errorExit(`Invalid format '${argv[i]}'. Must be csv, json, or table.`);
      }
      args.format = fmt as "csv" | "json" | "table";
      i++;
    } else {
      errorExit(`Unknown option: '${arg}'. Use --help for usage information.`);
    }
  }

  return args;
}

function errorExit(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
  throw new Error(msg);
}

function resolveTableName(name: string): string {
  if (name === "stdin") return name;
  if (path.extname(name) === "") {
    return name + ".csv";
  }
  return name;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (!args.query) {
    errorExit(
      'No query specified. Use -q "<SQL>" to provide a query. Use --help for usage information.',
    );
  }

  let stmt;
  try {
    stmt = parse(args.query);
  } catch (err: any) {
    errorExit(`SQL parse error: ${err.message}`);
  }

  const tables: Record<string, CsvTable> = {};
  const tableNames = [stmt.from];
  if (stmt.join) {
    tableNames.push(stmt.join.table);
  }

  for (const rawName of tableNames) {
    const resolvedName = resolveTableName(rawName);
    if (resolvedName === "stdin.csv" || rawName === "stdin") {
      try {
        tables[rawName] = await loadTableFromStdin();
      } catch (err: any) {
        errorExit(`Failed to read from stdin: ${err.message}`);
      }
    } else {
      try {
        tables[rawName] = loadTableFromFile(resolvedName);
      } catch (err: any) {
        errorExit(err.message);
      }
    }
  }

  let result;
  try {
    result = execute(stmt, tables);
  } catch (err: any) {
    errorExit(`Execution error: ${err.message}`);
  }

  let output: string;
  switch (args.format) {
    case "json":
      output = toJson(result.headers, result.rows);
      break;
    case "table":
      output = toTable(result.headers, result.rows);
      break;
    case "csv":
    default:
      output = toCsv(result.headers, result.rows);
      break;
  }

  process.stdout.write(output + "\n");
  process.exit(0);
}

main().catch((err: any) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
