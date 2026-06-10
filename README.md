# csvsql - 用 SQL 查询 CSV 文件的命令行工具

一个迷你版 csvsql/q，支持对 CSV 文件执行 SQL 查询，将结果输出到标准输出。纯 TypeScript + Node.js 实现，不依赖任何第三方 SQL 解析库、查询引擎或 CSV 解析库。

## 快速开始

```bash
# 安装依赖 & 编译
npm install
npm run build

# 基本用法
node dist/cli.js -q "SELECT * FROM samples/employees.csv"

# 带条件、排序、分页
node dist/cli.js -q "SELECT name, age FROM samples/employees.csv WHERE age >= 18 ORDER BY age DESC LIMIT 5"

# 输出为 JSON 或表格
node dist/cli.js -q "SELECT * FROM samples/employees.csv" -f json
node dist/cli.js -q "SELECT * FROM samples/employees.csv" -f table
```

## 命令行选项

| 选项 | 说明 |
|------|------|
| `-q, --query <SQL>` | 要执行的 SQL 查询（必填） |
| `-f, --format <fmt>` | 输出格式：`csv`（默认）、`json`、`table` |
| `-h, --help` | 显示帮助信息 |

## 支持的 SQL 语法

### SELECT
```sql
SELECT * FROM file.csv
SELECT name, age FROM file.csv
SELECT name AS employee_name, salary AS pay FROM file.csv
```

### WHERE 条件
```sql
-- 比较运算符
WHERE age >= 18
WHERE department = 'Engineering'
WHERE salary != 50000

-- 逻辑运算符
WHERE age > 25 AND department = 'Engineering'
WHERE department = 'Sales' OR department = 'Marketing'
WHERE NOT department = 'Engineering'

-- 括号控制优先级
WHERE age >= 30 AND (department = 'Engineering' OR department = 'Sales')

-- LIKE 模糊匹配（% 任意序列，_ 单个字符）
WHERE name LIKE 'A%'
WHERE name LIKE '_o%'
```

### ORDER BY
```sql
ORDER BY age DESC
ORDER BY department ASC, salary DESC
```

### LIMIT / OFFSET
```sql
LIMIT 5
LIMIT 3 OFFSET 2
```

### 聚合函数 + GROUP BY + HAVING
```sql
SELECT department, COUNT(*) AS cnt, AVG(salary) AS avg_sal
FROM file.csv
GROUP BY department

SELECT department, COUNT(*) AS cnt
FROM file.csv
GROUP BY department
HAVING COUNT(*) > 3
```

支持的聚合函数：`COUNT(*)`、`COUNT(列)`、`SUM`、`AVG`、`MIN`、`MAX`

### INNER JOIN
```sql
SELECT e.name, d.dept_name
FROM employees.csv e
INNER JOIN departments.csv d ON e.dept_id = d.dept_id
```

### 类型自动推断
数字列自动按数值比较和运算，不会出现 `"10" < "9"` 的字符串比较问题。

### 从标准输入读取
```bash
cat data.csv | node dist/cli.js -q "SELECT * FROM stdin WHERE value > 100"
```

## 错误处理

- SQL 语法错误：在 stderr 指出错误位置和原因，退出码 1
- 文件不存在：在 stderr 提示文件路径，退出码 1
- 查询执行错误：在 stderr 提示具体原因，退出码 1
- 正常执行：退出码 0

## 项目结构 & 模块说明

```
src/
├── lexer.ts      — 词法分析器：将 SQL 字符串切分为 Token 流
├── parser.ts     — 语法分析器：将 Token 流解析为 AST（抽象语法树）
├── executor.ts   — 执行引擎：对内存中的 CSV 数据执行过滤/排序/分组/聚合/连接
├── csv.ts        — CSV 解析器 & 输出格式化：解析 CSV（含引号/逗号/换行/转义），输出 CSV/JSON/Table
└── cli.ts        — 命令行入口：参数解析、文件加载、串联各模块
```

| 模块 | 职责 |
|------|------|
| `lexer.ts` | 词法分析。逐字符扫描 SQL，识别关键字、标识符、数字、字符串、运算符等，输出 Token 数组。遇到非法字符会报出具体位置。 |
| `parser.ts` | 语法分析。基于递归下降法，将 Token 流解析为结构化的 AST（SelectStatement），支持 SELECT / FROM / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET / JOIN 等子句。 |
| `executor.ts` | 查询执行。接收 AST 和 CSV 表数据，依次执行 JOIN → WHERE 过滤 → GROUP BY 分组 → 聚合计算 → HAVING 过滤 → ORDER BY 排序 → LIMIT/OFFSET 分页 → 列投影。自动推断数字类型。 |
| `csv.ts` | CSV 解析与输出。手写状态机解析 CSV，正确处理带双引号的字段、字段内逗号/换行、双引号转义（""）。提供 CSV / JSON / Table 三种输出格式。 |
| `cli.ts` | 命令行界面。解析 -q/-f/-h 参数，加载 CSV 文件或 stdin，调用 parser → executor → formatter 管线，处理错误并输出结果。 |

## 示例数据

`samples/` 目录下提供了三个测试用 CSV 文件：

- `employees.csv` — 员工数据（含 id、name、age、department、salary、dept_id）
- `departments.csv` — 部门数据（含 dept_id、dept_name、location）
- `products.csv` — 产品数据（含带逗号/引号/换行的复杂字段，用于测试 CSV 解析）
