# Windows 本地运行手册

这份手册给没有 bash、也没有 Docker 的 Windows 开发机。按这里启动 PostgreSQL、Redis、MinIO、解析器、worker 和 web，再走一次上传、解析、辅导、作答。自检脚本只读：不启动服务，不停止服务，不改 `.env`，不打印任何环境变量的值。

命令都在仓库根目录执行。下面只写端口、目录和变量名。连接串、口令和对象存储密钥留在你自己的 `.env` 里，不要抄进这份文档。

## 不要复用的实例

`scripts/opening-e2e/environment.mjs` 把 e2e 固定在 `127.0.0.1:15432` 的 `aistudy_opening_e2e`。`docs/quality/2026-10-05-opening-repo-review.md` 记录这个 15432 实例被另一条分支线共用，迁移历史不明。集成测试不要用它。

集成测试要单独的 PostgreSQL 实例、单独的数据目录，库名必须正好是 `aistudy_opening_test`，主机必须是 `127.0.0.1`、`localhost` 或 `::1`，并且 `OPENING_TEST_DB=1`。这是 `tests/integration/opening-fixture.ts` 和 `scripts/opening-test-db.mjs` 的守卫。本手册把这个实例放在端口 5434、数据目录 `.local\opening-test-pg`，避开开发库 5432、`.env.example` 里的 5433，以及共用的 15432。

MinIO 的开发实例监听 9000，数据目录用 `.local\miniodata`。e2e 的对象在 19000。如果 `.env` 里的 `S3_ENDPOINT` 指向 `http://127.0.0.1:19000`，开发和 e2e 会共用对象。那只能当临时替代，风险是两边互相覆盖。本任务不修改 `.env`。

## 端口和目录

| 用途 | 端口 | 数据或程序 |
| --- | --- | --- |
| 开发 PostgreSQL | 5432 | 数据 `.local\pgdata`，程序 `.local\pgsql\bin\pg_ctl.exe`。现有 `postgresql.conf` 没有改端口，所以是默认 5432 |
| 集成测试 PostgreSQL | 5434 | 数据 `.local\opening-test-pg`，库名 `aistudy_opening_test`。目录还不存在，第一次按下面的命令初始化 |
| Redis | 6379 | `.local\redis8\redis-server.exe`，配置 `.local\redis8\redis.conf` |
| MinIO API | 9000 | `.local\minio.exe`，数据 `.local\miniodata` |
| MinIO 控制台 | 9001 | 同上 |
| web | 3000 | `npm run dev`，也就是 `next dev --port 3000` |
| 解析器 | 无独立端口 | worker 按需调用 `.local\docling-venv\Scripts\python.exe`，工作目录 `services\parser` |

## 启动顺序

1. 开发 PostgreSQL。数据目录已经在 `.local\pgdata`，不要对它再跑 `initdb`。

```powershell
.\.local\pgsql\bin\pg_ctl.exe start -D .\.local\pgdata -l .\.local\pg.log
.\.local\pgsql\bin\pg_ctl.exe status -D .\.local\pgdata
```

2. Redis。

```powershell
.\.local\redis8\redis-server.exe .\.local\redis8\redis.conf
```

3. MinIO。开发和 e2e 分开，所以地址是 9000，不是 19000。

```powershell
.\.local\minio.exe server .\.local\miniodata --address :9000 --console-address :9001
```

4. 解析器没有常驻进程。`.local\docling-venv` 已经存在时不用重装。worker 启动前会自己跑 `python -m opening_parser --check`。要单独确认时：

```powershell
$env:PARSER_PYTHON = Join-Path (Get-Location) '.local\docling-venv\Scripts\python.exe'
$env:PARSER_CWD = Join-Path (Get-Location) 'services\parser'
Push-Location $env:PARSER_CWD
& $env:PARSER_PYTHON -m opening_parser --check
Pop-Location
```

模型缓存默认是 `.local\hf-home`。缺模型时按 `services/parser/README.md` 做一次 `prepare_models`，不要在每次解析时下载。

5. worker，然后 web。各开一个窗口。

```powershell
npm run worker:dev
npm run dev
```

web 起来后打开 `http://127.0.0.1:3000`。

6. 集成测试用的 PostgreSQL 只在要跑 handler 或 integration 时启动。不要把它指到 15432。

```powershell
.\.local\pgsql\bin\initdb.exe -D .\.local\opening-test-pg -E UTF8 --locale=C --username=postgres
```

初始化之后，在 `.local\opening-test-pg\postgresql.conf` 里把 `port` 设为 `5434`，再启动，并创建库 `aistudy_opening_test`。

```powershell
.\.local\pgsql\bin\pg_ctl.exe start -D .\.local\opening-test-pg -l .\.local\opening-test-pg.log
.\.local\pgsql\bin\createdb.exe -h 127.0.0.1 -p 5434 aistudy_opening_test
```

`OPENING_TEST_DATABASE_URL` 必须指向这台回环上的 `aistudy_opening_test`，同时设 `OPENING_TEST_DB=1`。值只放在环境或 `.env` 里。跑测试用 `node scripts/opening-test-db.mjs -- <命令>`，它会拒绝别的库名和别的主机。

## 停止

在对应窗口里按 Ctrl+C 可以停 Redis、MinIO、worker 和 web。PostgreSQL 用：

```powershell
.\.local\pgsql\bin\pg_ctl.exe stop -D .\.local\pgdata
.\.local\pgsql\bin\pg_ctl.exe stop -D .\.local\opening-test-pg
.\.local\redis8\redis-cli.exe -p 6379 shutdown
```

测试实例还没初始化时，第二条 `pg_ctl stop` 会失败，忽略即可。自检脚本不会替你执行这些命令。

## 日志

| 进程 | 日志 |
| --- | --- |
| 开发 PostgreSQL | `.local\pg.log`（上面的 `pg_ctl -l`） |
| 测试 PostgreSQL | `.local\opening-test-pg.log` |
| Redis | 当前窗口。要留档就重定向到已有的 `.local\redis.log` |
| MinIO | 当前窗口。要留档就重定向到已有的 `.local\minio.log` |
| worker | 当前窗口。已有 `.local\worker-dev.log` 可以接着追加 |
| web | 当前窗口。已有 `.local\web-dev.log` 可以接着追加 |

## 环境变量

自检只报告这些名字是已设置还是未设置，不打印值。应用要的是 `.env.example` 里列出的 `DATABASE_URL`、`REDIS_URL`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`PUBLIC_BASE_URL`。解析器再加 `PARSER_PYTHON` 和 `PARSER_CWD`。集成测试再加 `OPENING_TEST_DATABASE_URL` 和 `OPENING_TEST_DB`。

`PARSER_PYTHON` 未设置时，worker 会回落到 `.local\docling-venv\Scripts\python.exe`。自检这时仍会写 `env PARSER_PYTHON set: false`，另外再写默认路径是否存在。

## 没有 bash 时的检查

根目录和 `apps/web`、`apps/worker` 的 `typecheck`、`lint`、`test`、`build` 会走 `scripts/run-heavy.sh`。这台机器没有 bash，那些 npm 脚本会失败。改用：

```powershell
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --project unit
node node_modules/eslint/bin/eslint.js apps/web/src/features/opening
```

`packages/*` 的 typecheck 本身就是直接 `tsc`，照它自己的脚本跑。

## 走一次闭环

服务起来之后：

1. 打开 `http://127.0.0.1:3000/opening/library`，上传一份材料，等 worker 把解析跑完。
2. 打开 `http://127.0.0.1:3000/opening/today`，从今天的任务进入辅导。
3. 打开 `http://127.0.0.1:3000/opening/courses`，进一门课作答。
4. 补测还没有今天页入口。那一步属于 DL3，这份手册不编造按钮。作答之后就停，等 DL3 落地再走补测。

## 只读自检

```powershell
node --test scripts/opening-local-check.test.mjs
node scripts/opening-local-check.mjs
```

自检连接 5432、6379、9000、9001、3000、5434，请求 `http://127.0.0.1:3000/api/opening/health`，看 `database`、`redis`、`storage`、`workerBacklog` 是不是 `up`。再请求 `GET /api/opening/ai-readiness`。DL7 还没落地时这一项是 `not-implemented`。接口要登录时是 `unauthorized`。自检不带会话，也不会为了这一项去登录。

输出里只有端口、开闭、`up`/`down`、`set: true`/`set: false` 和就绪项的 `ok`。退出码 0 表示这些项全都通过。缺任何一项都是退出码 1，并且那一项会写明缺什么。把输出存下来当证据。这个脚本不启动、不停止任何服务。

## 常见故障

- `npm run typecheck` 或 `npm run test` 报找不到 bash：用上面的 `node` 命令，不要装一个来路不明的 bash 去绕。
- 健康检查 `down`：看同一行是 database、redis、storage 还是 workerBacklog，回到对应的窗口。不要用自检脚本去重启。
- 自检写 `postgres-test 5434 open: false`：测试实例还没初始化。只跑今天页时可以先记着这一项；跑 handler 或 integration 之前必须补上，并且仍然不要用 15432。
- 自检写 `ai-readiness state: not-implemented`：DL7 的路由还没有。这不是连错端口。
- 自检写 `ai-readiness state: unauthorized`：路由在，但没有登录会话。自检不会去登录。
- MinIO 连上了但对象串了：检查 `S3_ENDPOINT` 是不是还指着 19000。
