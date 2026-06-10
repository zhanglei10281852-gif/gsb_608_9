# csvsql-mini

一个用 TypeScript + Node.js 标准库从零实现的命令行工具，可以对 CSV 文件运行 SQL 查询，类似一个迷你版的 `csvsql` / `q`。

> 没有用任何第三方 SQL 解析库、查询引擎或 CSV 解析库。词法、语法、执行、CSV 解析全部自己实现，依赖只有 `typescript`（构建期）和 `@types/node`（类型）。

## 安装与构建

```bash
npm install
npm run build
```

## 使用

```bash
# 基本：把 SQL 写在 -q 后面，CSV 路径用单引号写成字符串字面量
node dist/cli.js -q "SELECT name, age FROM 'examples/people.csv' WHERE age >= 18 ORDER BY age DESC LIMIT 5"

# 也可以用文件存 SQL
node dist/cli.js -f query.sql

# 从标准输入读 CSV，表名默认就叫 stdin（可以用 --stdin-as 改名）
Get-Content examples/people.csv | node dist/cli.js -q "SELECT * FROM stdin LIMIT 3"

# 输出格式
node dist/cli.js --format csv   -q "..."   # 默认
node dist/cli.js --format json  -q "..."
node dist/cli.js --format table -q "..."

# 帮助
node dist/cli.js --help
```

正常成功 exit code 是 0；SQL 语法错、文件不存在、运行期错误等都会在 stderr 打印 `error: ...` 并以非零退出。语法错还会带一行 `^` 指向出错位置。

## 支持的 SQL 子集

```
SELECT  <select_list>
FROM    <table_ref>
[ [INNER] JOIN <table_ref> ON <expr> ]*
[ WHERE <expr> ]
[ GROUP BY <col>, ... [ HAVING <expr> ] ]
[ ORDER BY <expr> [ASC|DESC], ... ]
[ LIMIT <n> [OFFSET <n>] ]
```

- **SELECT**：`*`、`alias.*`、表达式、`expr AS alias`、`expr alias`（隐式别名）。
- **FROM / JOIN**：表来源可以是
  - 标识符（如 `people`，会自动尝试 `people.csv`），
  - 单引号字符串（如 `'examples/people.csv'`，可包含路径分隔符），
  - 或 `stdin`（从标准输入读 CSV）。
  - 支持 `INNER JOIN ... ON <equality>`（等值连接，但 ON 后是任意布尔表达式都行）。
- **WHERE / HAVING / ON**：
  - 比较运算 `=`、`!=`（`<>` 也认）、`<`、`<=`、`>`、`>=`。
  - 逻辑 `AND`、`OR`、`NOT`，括号控制优先级。
  - `LIKE`：`%` 匹配任意长度，`_` 匹配单个字符。
  - `IS NULL` / `IS NOT NULL`（空字符串视为 NULL）。
- **ORDER BY**：多列、`ASC` / `DESC`，可以用 SELECT 中的别名。
- **LIMIT / OFFSET**：非负整数。
- **聚合**：`COUNT(*)`、`COUNT(col)`、`SUM(col)`、`AVG(col)`、`MIN(col)`、`MAX(col)`，配合 `GROUP BY` 与 `HAVING`。
- **类型**：每一列在加载时按"所有非空值是否都能解析为有限数字"决定列类型。数字列按数字比较和运算；文本列按字符串比较。所以 `"10" > "9"` 在 `score` 这种数字列里是 `true`，而不是字符串字典序。

不支持：子查询、`UNION` / `INTERSECT`、窗口函数、`DISTINCT`、`CASE`、`UPDATE` / `INSERT` 等。

## 命令行选项

```
-q, --query <sql>     SQL 查询字符串
-f, --file  <path>    从文件读 SQL
    --format <fmt>    csv（默认）| json | table
    --stdin-as <name> 把标准输入注册成什么表名（默认 stdin）
-h, --help            打印帮助
```

退出码：成功 `0`；解析错误 / 执行错误 `1`；CLI 参数错误 `2`。

## 模块拆分

代码全部放在 [src/](file:///e:/gsb/608/gsb_9/Summer/src) 目录，分成五个职责清晰的模块：

| 文件 | 职责 |
| --- | --- |
| [csv.ts](file:///e:/gsb/608/gsb_9/Summer/src/csv.ts) | 自己写的 CSV 解析器与序列化器，按 RFC 4180 处理双引号包裹、字段内逗号/换行、`""` 转义等。 |
| [lexer.ts](file:///e:/gsb/608/gsb_9/Summer/src/lexer.ts) | SQL 词法分析：把 SQL 字符串切成 token（标识符 / 关键字 / 数字 / 字符串字面量 / 运算符 / 标点）。 |
| [parser.ts](file:///e:/gsb/608/gsb_9/Summer/src/parser.ts) | 手写递归下降语法分析，按运算符优先级生成 AST（`SelectQuery` 及各种 `Expr`）。 |
| [executor.ts](file:///e:/gsb/608/gsb_9/Summer/src/executor.ts) | 执行器：加载表、推断列类型、做 JOIN / WHERE / GROUP / 聚合 / HAVING / ORDER BY / LIMIT，再投影 SELECT；同时负责 CSV / JSON / 表格三种输出格式。 |
| [cli.ts](file:///e:/gsb/608/gsb_9/Summer/src/cli.ts) | 命令行入口：参数解析、`--help`、stdin 读取、错误打印（带位置指示）、退出码。 |

整体数据流：`SQL string → tokenize() → parse() → execute(query, loader) → formatResult()`。
任意一步抛错都会被 [cli.ts](file:///e:/gsb/608/gsb_9/Summer/src/cli.ts) 统一捕获并写到 stderr。

## 示例数据

- [examples/people.csv](file:///e:/gsb/608/gsb_9/Summer/examples/people.csv) — 10 个人，包含包含逗号的城市名 (`"Shanghai, Pudong"`) 与含转义双引号的姓名 (`"Henry ""The Boss"" Liu"`)，用于测试 CSV 边界情况。
- [examples/depts.csv](file:///e:/gsb/608/gsb_9/Summer/examples/depts.csv) — 部门维度表，用于 JOIN。
- [examples/scores.csv](file:///e:/gsb/608/gsb_9/Summer/examples/scores.csv) — 用于验证数字 vs 字符串排序的差异。

## 验证用例 & 实际输出

下面这些命令都是在 PowerShell 里直接跑过的真实输出，把要求里列出的所有能力都覆盖了。

### 1. 基本：过滤 + 排序 + LIMIT

```
> node dist/cli.js -q "SELECT name, age FROM 'examples/people.csv' WHERE age >= 18 ORDER BY age DESC LIMIT 5"
name,age
Frank,55
Carol,42
"Henry ""The Boss"" Liu",40
Jack,33
Alice,30
```

注意 `Henry "The Boss" Liu` 这种含引号的字段在输出里被正确转义回去；`age >= 18` 是按数字比较的。

### 2. LIKE + AND/OR/NOT + 括号 + 字段中含逗号

```
> node dist/cli.js -q "SELECT name, city FROM 'examples/people.csv' WHERE name LIKE 'A%' OR (city LIKE 'Sh%' AND age > 20)"
name,city
Alice,Beijing
Eve,"Shanghai, Pudong"
Ivy,Shanghai
```

`"Shanghai, Pudong"`（字段里含逗号）被正确解析，并被 `LIKE 'Sh%'` 命中。

### 3. `_` 通配 + NOT

```
> node dist/cli.js -q "SELECT name FROM 'examples/people.csv' WHERE name LIKE '_ve'"
name
Eve
```

```
> node dist/cli.js -q "SELECT name FROM 'examples/people.csv' WHERE NOT (age < 18) AND city != 'Beijing' ORDER BY name"
name
Eve
Grace
Ivy
Jack
```

### 4. GROUP BY + HAVING + 聚合 + ORDER BY 用别名

```
> node dist/cli.js -q "SELECT city, COUNT(*) AS cnt, AVG(age) AS avg_age FROM 'examples/people.csv' GROUP BY city HAVING COUNT(*) >= 2 ORDER BY cnt DESC, city ASC"
city,cnt,avg_age
Beijing,4,41.75
Guangzhou,2,21
Shanghai,2,19.5
```

### 5. 全表聚合 + JSON 输出

```
> node dist/cli.js --format json -q "SELECT MIN(age) AS min_age, MAX(age) AS max_age, SUM(age) AS sum_age, COUNT(*) AS total FROM 'examples/people.csv'"
[
  {
    "min_age": 9,
    "max_age": 55,
    "sum_age": 291,
    "total": 10
  }
]
```

### 6. INNER JOIN + 表别名 + 列别名

```
> node dist/cli.js -q "SELECT p.name, p.age, d.name AS dept FROM 'examples/people.csv' p INNER JOIN 'examples/depts.csv' d ON p.dept_id = d.id WHERE p.age >= 18 ORDER BY d.name, p.age DESC"
p.name,p.age,dept
Frank,55,Engineering
Carol,42,Engineering
"Henry ""The Boss"" Liu",40,Engineering
Alice,30,Engineering
Jack,33,Marketing
Grace,18,Marketing
Eve,25,Sales
Ivy,22,Sales
```

### 7. 数字 vs 字符串排序的区别

```
> node dist/cli.js -q "SELECT name, score FROM 'examples/scores.csv' ORDER BY score ASC"
name,score
Alice,9
Dave,9.5
Bob,10
Carol,80
```

如果是按字符串排序，`"10"` 会跑到 `"9"` 前面；这里 `score` 列的值都能解析成数字，所以工具自动把它当数字列处理。

### 8. 分页 OFFSET + 表格输出

```
> node dist/cli.js --format table -q "SELECT name, age FROM 'examples/people.csv' ORDER BY age DESC LIMIT 3 OFFSET 2"
+----------------------+-----+
| name                 | age |
+----------------------+-----+
| Henry "The Boss" Liu | 40  |
| Jack                 | 33  |
| Alice                | 30  |
+----------------------+-----+
```

### 9. 标准输入 + 默认表名 `stdin`

```
> Get-Content examples/people.csv | node dist/cli.js -q "SELECT name, age FROM stdin WHERE age >= 18 ORDER BY age ASC LIMIT 3"
name,age
Grace,18
Ivy,22
Eve,25
```

### 10. 错误处理（stderr + 非零退出码）

SQL 语法错（`FORM` 拼错），错误信息会指出位置并画一个 `^`：

```
> node dist/cli.js -q "SELECT name FORM people.csv"; Write-Host "exit=$LASTEXITCODE"
error: Parse error at position 18: expected FROM, got IDENT 'people'
  SELECT name FORM people.csv
                   ^
exit=1
```

文件不存在：

```
> node dist/cli.js -q "SELECT * FROM 'nope.csv'"; Write-Host "exit=$LASTEXITCODE"
error: table source not found: 'nope.csv'
exit=1
```
