#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { parseSQL } from './sql/parser';
import { executeQuery } from './executor/executor';
import { formatOutput, OutputFormat } from './output/formatter';

interface CliOptions {
  query?: string;
  format: OutputFormat;
  help: boolean;
  inputFile?: string;
}

const HELP_TEXT = `
csv-sql: Run SQL queries on CSV files

Usage:
  csv-sql -q "SELECT * FROM people.csv"
  csv-sql --query "SELECT name, age FROM people.csv WHERE age >= 18"
  cat people.csv | csv-sql -q "SELECT * FROM stdin" --format table

Options:
  -q, --query <sql    SQL query to execute
  -f, --format <fmt> Output format: csv, json, table (default: csv)
  -h, --help         Show this help message

Supported SQL features:
  - SELECT columns, *, column aliases (AS)
  - WHERE with =, !=, <, <=, >, >=, AND/OR/NOT, parentheses
  - LIKE with % and _ wildcards
  - ORDER BY (ASC/DESC), multiple columns
  - LIMIT and OFFSET
  - Aggregate functions: COUNT(*), COUNT(column), SUM, AVG, MIN, MAX
  - GROUP BY and HAVING
  - INNER JOIN ... ON (equi-join)
  - Numeric and string type detection
`;

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    format: 'csv',
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      i++;
    } else if (arg === '-q' || arg === '--query') {
      i++;
      if (i < args.length) {
        options.query = args[i];
        i++;
      } else {
        throw new Error('Missing value for --query');
      }
    } else if (arg === '-f' || arg === '--format') {
      i++;
      if (i < args.length) {
        const fmt = args[i].toLowerCase();
        if (fmt === 'csv' || fmt === 'json' || fmt === 'table') {
          options.format = fmt;
        } else {
          throw new Error(`Invalid format: ${fmt}. Must be csv, json, or table`);
        }
        i++;
      } else {
        throw new Error('Missing value for --format');
      }
    } else if (!arg.startsWith('-')) {
      if (!options.inputFile) {
        options.inputFile = arg;
      }
      i++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');

    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    process.stdin.on('error', reject);
  });
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    if (options.help) {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    if (!options.query) {
      console.error('Error: SQL query is required. Use -q or --query to specify it.');
      console.error('Use --help for more information.');
      process.exit(1);
    }

    const ast = parseSQL(options.query);

    const stdinData = await readStdin();
    const baseDir = process.cwd();
    const result = executeQuery(ast, baseDir, stdinData);

    const output = formatOutput(result.headers, result.rows, options.format);
    console.log(output);

    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
