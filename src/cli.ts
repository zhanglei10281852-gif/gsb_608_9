#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { parseCSV } from './csv';
import { Parser } from './parser';
import { executeQuery, QueryResult } from './executor';
import { formatResult, OutputFormat } from './formatter';
import { ParseError } from './lexer';

const HELP_TEXT = `csvsql-mini - Run SQL queries on CSV files

Usage:
  csvsql-mini -q "SQL_QUERY" [options]
  csvsql-mini --query "SQL_QUERY" [options]
  cat file.csv | csvsql-mini -q "SELECT * FROM stdin"

Options:
  -q, --query <sql>       SQL query to execute (required)
  -f, --format <format>   Output format: csv, json, table (default: csv)
  -h, --help              Show this help message

SQL Syntax Supported:
  SELECT col1, col2 AS alias, *
  FROM filename.csv
  [INNER] JOIN other.csv ON t1.id = t2.id
  WHERE conditions with = != < <= > >= AND OR NOT LIKE 'pattern%'
  GROUP BY col
  HAVING condition
  ORDER BY col ASC|DESC, col2 DESC
  LIMIT N
  OFFSET N

Aggregates: COUNT(*), COUNT(col), SUM(col), AVG(col), MIN(col), MAX(col)

LIKE patterns: % matches any sequence, _ matches single character
`;

function parseArgs(args: string[]): { query: string; format: OutputFormat; help: boolean } {
  let query = '';
  let format: OutputFormat = 'csv';
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-q' || arg === '--query') {
      query = args[++i] || '';
    } else if (arg === '-f' || arg === '--format') {
      const fmt = args[++i];
      if (fmt === 'csv' || fmt === 'json' || fmt === 'table') {
        format = fmt;
      } else {
        throw new Error(`Unknown format: ${fmt}. Use csv, json, or table.`);
      }
    } else if (arg.startsWith('--query=')) {
      query = arg.slice('--query='.length);
    } else if (arg.startsWith('--format=')) {
      const fmt = arg.slice('--format='.length);
      if (fmt === 'csv' || fmt === 'json' || fmt === 'table') {
        format = fmt;
      }
    } else if (!query && !arg.startsWith('-')) {
      query = arg;
    }
  }

  return { query, format, help };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function extractTableNames(sql: string): string[] {
  const tables: string[] = [];
  const fromMatch = sql.match(/FROM\s+([^\s,;]+)/i);
  if (fromMatch) tables.push(fromMatch[1]);
  const joinMatches = sql.matchAll(/JOIN\s+([^\s,;]+)/gi);
  for (const m of joinMatches) tables.push(m[1]);
  return tables;
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const { query, format, help } = parseArgs(args);

    if (help) {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    if (!query) {
      console.error('Error: No query provided. Use -q or --query to specify SQL, or --help for usage.');
      process.exit(1);
    }

    const ast = Parser.parse(query);

    const tables: { [name: string]: ReturnType<typeof parseCSV> } = {};
    const tableNamesToLoad = new Set<string>();
    tableNamesToLoad.add(ast.from);
    if (ast.joins) {
      for (const j of ast.joins) tableNamesToLoad.add(j.table);
    }

    const stdinData = await readStdin();

    for (const tableName of tableNamesToLoad) {
      let fileToLoad = tableName;
      if (!fs.existsSync(fileToLoad)) {
        if (fs.existsSync(fileToLoad + '.csv')) {
          fileToLoad = fileToLoad + '.csv';
        } else if (tableName === 'stdin' || tableName === 'stdin.csv') {
          if (stdinData) {
            tables['stdin'] = parseCSV(stdinData);
            continue;
          } else {
            console.error(`Error: Table '${tableName}' not found and no stdin data available.`);
            process.exit(1);
          }
        } else {
          console.error(`Error: File not found: '${tableName}' (tried '${tableName}.csv')`);
          process.exit(1);
        }
      }
      const csvText = fs.readFileSync(fileToLoad, 'utf8');
      const parsed = parseCSV(csvText);
      tables[tableName] = parsed;
      tables[fileToLoad] = parsed;
      const baseName = path.basename(fileToLoad);
      tables[baseName] = parsed;
      const noExt = path.basename(fileToLoad, path.extname(fileToLoad));
      tables[noExt] = parsed;
      const tableNameNoExt = tableName.replace(/\.[^/.]+$/, '');
      if (tableNameNoExt !== tableName) {
        tables[tableNameNoExt] = parsed;
      }
    }

    const result: QueryResult = executeQuery(ast, tables);
    const output = formatResult(result, format);
    console.log(output);
    process.exit(0);
  } catch (err: any) {
    if (err instanceof ParseError) {
      const sqlSnippet = process.argv.slice(2).join(' ').match(/-q\s+(.*)/)?.[1] || '';
      console.error('SQL Parse Error: ' + err.message);
      if (err.position !== undefined && sqlSnippet) {
        console.error('  ' + sqlSnippet);
        console.error('  ' + ' '.repeat(Math.max(0, err.position)) + '^');
      }
    } else if (err.code === 'ENOENT') {
      console.error(`Error: File not found: '${err.path}'`);
    } else {
      console.error('Error: ' + err.message);
    }
    process.exit(1);
  }
}

main();
