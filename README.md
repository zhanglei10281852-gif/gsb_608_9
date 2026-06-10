# csvsql-mini

一个用 TypeScript 从零实现的命令行工具，可以直接对 CSV 文件执行 SQL 查询，类似 csvsql / q。仅依赖 Node.js 标准库，没有使用任何 SQL 解析、查询引擎或 CSV 解析第三方库。

## 构建

```bash
npm install
npm run build
```

编译产物在 `dist/` 目录下。

## 用法

```bash
node dist/cli.js -q "SELECT name, age FROM people.csv WHERE age >= 18 ORDER BY age DESC LIMIT 5"
```

支持从文件读取 CSV，也支持从标准输入读取（表名用 `stdin`）：

```bash
cat data.csv | node dist/cli.js -q "SELECT * FROM stdin WHERE city = 'Beijing'"
```

### 命令行选项

| 选项 | 说明 |
|------|------|
| `-q, --query <sql>` | 要执行的 SQL 查询（必需） |
| `-f, --format <fmt>` | 输出格式：`csv`（默认）、`json`、`table` |
| `-h, --help` | 显示帮助信息 |

## 支持的 SQL 语法

```sql
SELECT [* | column [AS alias], ...]
FROM file.csv
[INNER] JOIN other.csv ON table1.col = table2.col
[WHERE conditions]
[GROUP BY col, ...]
[HAVING aggregate_conditions]
[ORDER BY col [ASC|DESC], ...]
[LIMIT n]
[OFFSET n]
```

### WHERE 条件支持

- 比较运算符：`=` `!=` `<` `<=` `>` `>=`
- 逻辑运算符：`AND` `OR` `NOT`
- 括号 `( )` 控制优先级
- `LIKE 'pattern'`：`%` 匹配任意序列，`_` 匹配单个字符（不区分大小写）

### 聚合函数

- `COUNT(*)` / `COUNT(col)`
- `SUM(col)`
- `AVG(col)`
- `MIN(col)`
- `MAX(col)`

聚合函数可配合 `GROUP BY` 和 `HAVING` 使用。

### 类型处理

- 数字列自动识别为数字类型，按数值比较和排序（所以 `10 > 9` 成立）
- 非数字字段按字符串处理
- 正确处理 CSV 中的：双引号包裹字段、字段内含逗号、字段内含换行、双引号转义（`""` 表示 `"`）

## 模块结构

代码位于 [src/](file:///e:/gsb/608/gsb_9/Autumn/src) 目录下，严格分层：

| 文件 | 职责 |
|------|------|
| [src/csv.ts](file:///e:/gsb/608/gsb_9/Autumn/src/csv.ts) | CSV 解析器与序列化器。自己实现状态机解析，正确处理引号、逗号、换行、`""` 转义；自动识别数字列；输出时正确转义特殊字符 |
| [src/lexer.ts](file:///e:/gsb/608/gsb_9/Autumn/src/lexer.ts) | 词法分析器（Lexer）。把原始 SQL 字符串切成 token 流（关键字、标识符、数字、字符串、运算符、括号等），记录每个 token 的位置便于报错 |
| [src/ast.ts](file:///e:/gsb/608/gsb_9/Autumn/src/ast.ts) | AST 节点类型定义，定义 SELECT 语句、表达式、连接、排序项等结构 |
| [src/parser.ts](file:///e:/gsb/608/gsb_9/Autumn/src/parser.ts) | 语法分析器（Parser）。递归下降解析，把 token 流构建成 AST；处理运算符优先级（OR < AND < NOT < 比较） |
| [src/executor.ts](file:///e:/gsb/608/gsb_9/Autumn/src/executor.ts) | 查询执行引擎。在内存中执行：JOIN（等值连接）→ WHERE 过滤 → GROUP BY 分组聚合 → HAVING 过滤 → SELECT 投影 → ORDER BY 排序 → LIMIT/OFFSET 分页 |
| [src/formatter.ts](file:///e:/gsb/608/gsb_9/Autumn/src/formatter.ts) | 结果格式化，支持 CSV、JSON、对齐文本表格三种输出格式 |
| [src/cli.ts](file:///e:/gsb/608/gsb_9/Autumn/src/cli.ts) | CLI 入口。解析命令行参数、读取文件/stdin、调用解析器+执行器、处理错误并以适当退出码退出 |

## 示例

示例 CSV 文件在 [examples/](file:///e:/gsb/608/gsb_9/Autumn/examples) 目录：

- `examples/people.csv`：15 条员工数据（id, name, age, city, salary, dept_id），包含带逗号的引号字段
- `examples/departments.csv`：部门表（dept_id, dept_name, location）
- `examples/numtest.csv`：数字排序测试数据

### 1. 过滤 + 排序 + 分页
```bash
node dist/cli.js -q "SELECT name, age FROM examples/people.csv WHERE age >= 18 ORDER BY age DESC LIMIT 5" -f table
```
输出：
```
name      | age
----------+----
Hank, Jr. | 55
Nick      | 48
Diana     | 42
Jack      | 40
Bob       | 35
```

### 2. LIKE + OR
```bash
node dist/cli.js -q "SELECT name, city FROM examples/people.csv WHERE city LIKE 'New%' OR name LIKE '_a%'" -f table
```
找出 New 开头城市或名字第二个字母是 a 的人。

### 3. GROUP BY + 聚合 + HAVING
```bash
node dist/cli.js -q "SELECT dept_id, COUNT(*) AS cnt, AVG(salary) AS avg_sal FROM examples/people.csv GROUP BY dept_id HAVING COUNT(*) >= 3 ORDER BY avg_sal DESC" -f table
```
统计每个部门人数、平均工资，只保留人数不少于 3 的部门，按平均工资降序。

### 4. INNER JOIN
```bash
node dist/cli.js -q "SELECT name, age, departments.dept_name FROM examples/people.csv INNER JOIN examples/departments.csv ON people.dept_id = departments.dept_id WHERE age < 25 ORDER BY age" -f table
```
连接两张表查出员工所在部门名。

### 5. JSON 输出
```bash
node dist/cli.js -q "SELECT name, age, salary FROM examples/people.csv WHERE dept_id = 2 ORDER BY salary DESC" -f json
```

## 错误处理

- SQL 语法错误时，在 stderr 打印错误信息并用 `^` 指出位置，退出码 1
- 文件不存在时打印清晰错误信息，退出码 1
- 查询成功时退出码 0
