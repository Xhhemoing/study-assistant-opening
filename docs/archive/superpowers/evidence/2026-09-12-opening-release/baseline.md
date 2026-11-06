# 隔离基线执行证据（2026-09-12）

工作区：`E:/Project/study-assistant-opening`；分支`feat/opening-release`；起点`e7639c9930bf230185551c86ea825e2524c40a39`。原工作区未提交改动未搬入、未覆盖。以下是实际命令/输出摘要，不代表五项新功能已交付。

## B00：依赖安装

1. `npm ci --no-audit --no-fund`失败：ECONNRESET，锁文件指向Tencent镜像。
2. 只读HEAD探测：同一tarball在旧镜像HTTP503，在官方源HTTP200。
3. 仅替换registry host的实验失败：错误保留`/npm/`前缀，官方URL返回404。
4. 最小修改：13个resolved URL移除旧镜像及其`/npm/`前缀；项目`.npmrc`使用官方HTTPS源与replace-registry-host=always。没有改变全局npm配置。
5. 对比原锁文件：13个resolved字段改变；版本、integrity及其他包字段不变。
6. `node --test tests/tooling/install-registry.test.mjs`：先2个断言失败，修复后`pass 2 / fail 0`。
7. `npm ci --fetch-retries=0 --fetch-timeout=20000 --no-audit --no-fund`成功：`added 400 packages in 46s`。

非阻塞提示：uuid@9弃用；npm提示msgpackr-extract/sharp/esbuild安装脚本尚未获得allow-scripts覆盖，本轮未批量放开。后续实际使用相关能力必须验证，不能假定所有可选原生路径已启用。

## B01：lint与类型检查

- 原基线lint失败4项：reviews路由未使用导入、预览图标未使用导入、类型重复导入、测试中未使用的外层pointId。
- 只删除未使用绑定；保留ImportedLink公开re-export和seedItem内实际使用的pointId。
- 修复后`npm run lint`退出0。
- 默认Windows npm shell执行嵌套bash脚本曾报`TS5025 Unknown compiler option --noEmit'`；根因是cmd与单引号转义，不是业务类型。
- 当前调用显式使用Git Bash：`npm --script-shell="$(cygpath -w "$(command -v bash)")" run typecheck`退出0。未改全局script-shell，也未将Windows绝对路径写进项目配置。
- `npm run verify:ci`：`verify:ci OK — CI workflow contract satisfied.`，其中3个契约断言通过。

## B02：生产构建边界

- 初次构建失败：`node:crypto -> portability/native/files.ts -> native/index.ts -> domain/index.ts -> practice-player.tsx`。
- 根因：浏览器使用的domain barrel重新导出依赖Node加密的备份函数。
- 增加回归测试，先观察到根导出含buildNativeBackup导致失败；SHA-256标准向量用例保持通过。
- 最小修复：新增`@aistudy/domain/native`子路径；根入口仅保留安全常量/错误与type-only导出；两个服务端repository改用子路径；Vitest增加更具体alias。
- 窄回归：`Test Files 3 passed (3)`；`Tests 8 passed (8)`。
- 修复后lint、完整typecheck均退出0。
- 构建命令：`npm --script-shell="$(cygpath -w "$(command -v bash)")" run build`。
- 实际输出：`Compiled successfully in 15.8s`；`Generating static pages (42/42)`；退出0。
- 没有禁用crypto、引入浏览器伪实现或改变备份哈希格式。

## 已运行的基线套件

修复安装后、B02新回归加入前：
`bash scripts/run-heavy.sh node node_modules/vitest/vitest.mjs run --project unit --project contract`
结果：`Test Files 113 passed (113)`；`Tests 513 passed (513)`；`Duration 77.13s`。

最终包含B02回归的全量结果在`final-verification.md`单独记录，不能把上面的历史513个用例冒充新功能覆盖。

## 未执行／限制

- 没有完整数据库、handler、浏览器真机、真实模型或恢复演练。本轮命令未使用用户已有.env或服务器。
- 本机未找到Docker与psql命令；未来测试数据库配置是集成验证前置条件，不允许改用用户真实库。
- heavy runner提示flock不可用；本轮重型门禁串行执行。
- 通过production build证明编译打包，不证明部署、真实AI效果或学习收益。

## 计划自审修正

- 修正备份验收依赖循环：Q03先实现打包恢复，Q01集成，Q02最终体验与样本验收。
- 明确0018->0019->0020迁移依赖；单一DATA所有者。
- 去掉F03依赖尚未实现上传路由的测试，改为直接repository隔离断言。
- 区分保存对话job与ephemeral即时请求，账本允许无持久job的requestKey，正文不入队。
- 为纸面观察加入sessionId、verdictSource，防止把自报正确或跨题提示当作真实独立证据。
- 不向生产引入“测试匿名请求头”；测试fixture直接构造不带cookie请求。
