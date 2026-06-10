# CSV-SQL

一个用 TypeScript + Node.js 从零实现的命令行工具，可以对 CSV 文件运行 SQL 查询。类似迷你版的 csvsql/q。

## 功能特点

- 纯 TypeScript 实现，零第三方依赖（只用 Node 标准库）
- 三层架构：词法分析 → 语法分析 → 执行引擎
- 支持实用的 SQL 子集
- 自动识别列类型（数字 vs 字符串），数字列按数值比较和运算
- 支持多种输出格式：CSV、JSON、Table
- CSV 解析支持带引号的字段、字段内逗号/换行、双引号转义

## 安装与构建

```bash
npm install
npm run build
```

编译产物输出到 `dist/` 目录。

## 用法

```bash
node dist/cli.js -q "SQL查询语句" [--format csv|json|table]
```

### 选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--query` | `-q` | 要执行的 SQL 查询语句（必填） |
| `--format` | `-f` | 输出格式：`csv`（默认）、`json`、`table` |
| `--help` | `-h` | 显示帮助信息 |

### 示例

```bash
# 基本查询，输出 CSV
node dist/cli.js -q "SELECT name, age FROM people.csv WHERE age >= 18 ORDER BY age DESC LIMIT 5"

# 输出为表格格式
node dist/cli.js -q "SELECT * FROM people.csv" --format table

# 输出为 JSON
node dist/cli.js -q "SELECT city, COUNT(*) as cnt FROM people.csv GROUP BY city" --format json

# 两个表 JOIN
node dist/cli.js -q "SELECT e.name, d.dept_name FROM employees.csv e INNER JOIN departments.csv d ON e.dept_id = d.dept_id" --format table
```

## 支持的 SQL 语法

### SELECT 子句

```sql
SELECT column1, column2 AS alias, *
SELECT COUNT(*), SUM(salary), AVG(age), MIN(id), MAX(score)
```

- 支持选择指定列
- 支持 `*` 通配符
- 支持列别名（`AS`）
- 支持聚合函数

### FROM 子句

```sql
SELECT * FROM filename.csv
SELECT * FROM filename.csv AS alias
SELECT * FROM filename.csv alias
```

### WHERE 子句

```sql
WHERE age >= 18 AND city = 'Beijing'
WHERE name LIKE 'A%' OR age < 20
WHERE NOT (status = 'inactive')
WHERE salary BETWEEN 50000 AND 100000
```

支持的比较运算符：
- `=` 等于
- `!=` 不等于
- `<` 小于
- `<=` 小于等于
- `>` 大于
- `>=` 大于等于
- `LIKE` 模式匹配（`%` 匹配任意字符，`_` 匹配单个字符）

支持的逻辑运算符：
- `AND` 与
- `OR` 或
- `NOT` 非
- 用括号控制优先级

### ORDER BY 子句

```sql
ORDER BY age
ORDER BY age DESC
ORDER BY city ASC, age DESC
```

支持多列排序，`ASC`（升序，默认）和 `DESC`（降序）。

### LIMIT / OFFSET

```sql
LIMIT 10
LIMIT 10 OFFSET 20
```

### GROUP BY + 聚合函数

```sql
SELECT city, COUNT(*) as cnt FROM people.csv GROUP BY city
SELECT dept_id, AVG(salary) as avg_sal, SUM(salary) as total FROM employees.csv GROUP BY dept_id
```

支持的聚合函数：
- `COUNT(*)` 计数
- `COUNT(column)` 非空值计数
- `SUM(column)` 求和
- `AVG(column)` 平均值
- `MIN(column)` 最小值
- `MAX(column)` 最大值

### HAVING 子句

```sql
SELECT dept_id, COUNT(*) as cnt FROM employees.csv GROUP BY dept_id HAVING COUNT(*) > 2
```

HAVING 子句用于对分组后的结果进行过滤，支持聚合函数表达式。

### INNER JOIN

```sql
SELECT e.name, d.dept_name
FROM employees.csv e
INNER JOIN departments.csv d
ON e.dept_id = d.dept_id
```

支持两个 CSV 表之间的内连接（等值连接）。表可以使用别名。

## 类型系统

工具会自动检测每一列的数据类型：

- **数字型**：如果一列的所有非空值都能解析为数字，则视为数字列，比较和运算按数值进行
- **字符串型**：否则按字符串处理，比较按字典序进行

这样确保了 "10" > "9"（数字比较），而不是字符串比较的 "10" < "9"。

## 代码结构

项目采用清晰的三层架构，模块划分如下：

```
src/
├── cli.ts              # 命令行入口
├── sql/
│   ├── ast.ts          # AST 类型定义
│   ├── lexer.ts        # 词法分析器（Tokenizer）
│   └── parser.ts       # 语法分析器（递归下降解析器）
├── csv/
│   └── parser.ts       # CSV 解析与格式化
├── executor/
│   └── executor.ts     # 查询执行引擎
└── output/
    └── formatter.ts    # 输出格式化（CSV/JSON/Table）
```

### 各模块职责

#### 1. `sql/ast.ts` — 抽象语法树定义
- 定义所有 SQL 语句和表达式的 AST 节点类型
- 包括 `SelectStatement`、表达式节点、表引用、连接子句等
- 是词法分析、语法分析、执行引擎之间的通用数据结构

#### 2. `sql/lexer.ts` — 词法分析器
- 输入：SQL 字符串
- 输出：Token 流
- 识别关键字、标识符、字符串字面量、数字、运算符等
- 跟踪行号和列号，用于错误定位
- 支持 `--` 单行注释和 `/* */` 多行注释

#### 3. `sql/parser.ts` — 语法分析器
- 输入：Token 流
- 输出：AST（抽象语法树）
- 使用递归下降解析法实现
- 按运算符优先级解析表达式：OR → AND → NOT → 比较 → 一元
- 支持 SELECT、FROM、WHERE、GROUP BY、HAVING、ORDER BY、LIMIT、OFFSET、JOIN

#### 4. `csv/parser.ts` — CSV 解析与格式化
- `parseCSV()`：状态机实现的 CSV 解析器
  - 支持带双引号的字段
  - 支持字段内包含逗号、换行符
  - 支持双引号转义（`""` → `"`）
- `detectColumnTypes()`：自动检测列类型（数字/字符串）
- `formatCSV()`：将数据格式化为 CSV 输出
- `escapeCSVField()`：正确转义 CSV 字段

#### 5. `executor/executor.ts` — 查询执行引擎
- 输入：AST + CSV 数据表
- 输出：查询结果（headers + rows）
- 执行流程：加载表 → JOIN → WHERE 过滤 → 分组聚合 → HAVING 过滤 → SELECT 投影 → ORDER BY 排序 → OFFSET → LIMIT
- 支持的操作：
  - 表达式求值（普通行上下文 / 分组上下文）
  - 条件过滤（WHERE / HAVING）
  - 排序（多列、ASC/DESC）
  - 分页（LIMIT / OFFSET）
  - 分组与聚合
  - 内连接（INNER JOIN）
  - LIKE 模式匹配
  - 智能值比较（数字 vs 字符串）

#### 6. `output/formatter.ts` — 输出格式化
- `formatOutput()`：根据指定格式输出结果
- `formatCSV()`：CSV 格式输出
- `formatJSON()`：JSON 数组格式输出
- `formatTable()`：带边框的表格格式输出，自动计算列宽

#### 7. `cli.ts` — 命令行入口
- 解析命令行参数
- 读取 SQL 查询
- 调用解析器和执行引擎
- 格式化并输出结果
- 错误处理（stderr 输出，非零退出码）

## 示例数据

项目包含几个示例 CSV 文件：

- `people.csv` — 人口数据（15 条记录）：id, name, age, city, salary
- `employees.csv` — 员工数据（10 条记录）：id, name, dept_id, salary
- `departments.csv` — 部门数据（5 条记录）：dept_id, dept_name, location
- `quotes_test.csv` — 带引号字段的测试数据

## 错误处理

- SQL 语法错误：显示错误位置（行号、列号）和附近的 token
- 文件不存在：清晰提示文件名
- 列不存在：提示列名
- 所有错误输出到 stderr，退出码为 1
- 正常退出码为 0

## 许可证

MIT
