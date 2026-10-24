# OPT-00 确定性合成材料包

只用于测试的原创小型材料，不含用户资料、真实题库或模型输出。**这里没有整包导入实现**：生成器写两个固定输出文件，验证器仅在内存读取归档条目，不把条目路径拼到文件系统。

## 生成

在仓库根目录执行（生成仅依赖 Node 标准库，无需新增 npm 包）：

```sh
node tests/fixtures/sprint-pack/generate.mjs --seed opt-00-v1
# 或写到指定的测试临时目录
node tests/fixtures/sprint-pack/generate.mjs --seed opt-00-v1 --out /tmp/sprint-pack-opt00
```

默认输出在本目录 `generated/`（已忽略），包含：

- `sprint-pack.zip`：真实、可由普通 ZIP 阅读器解析的归档。
- `manifest.json`：seed、归档和条目 SHA-256、原始文件名字节、编码/标志、预期角色、**1-based 物理页码**、条目数量、忽略/拒绝原因。

同 seed 的 ZIP 和 manifest **字节相同，因此 SHA-256 相同**。ZIP 使用 STORE、不加 Unicode 路径 extra field、固定条目顺序、权限和 DOS 时间 `1980-01-01 00:00:00`；PDF 对象编号/xref 固定，不写当前时间或随机 ID，不依赖系统字体生成。seed 按 UTF-8 十六进制写入每个 PDF 的 Subject，改变 seed 会改变真实 PDF/ZIP 字节，而不改变角色/页数。seed 必须为非空、至多 128 UTF-8 字节。哈希仅用于用户要求的夹具确定性与产物一致性验收，不新增产品 hash/gate。

## 两层定义与内容

**外 ZIP 深度 1，内 ZIP 深度 2；没有深度 3 的材料 ZIP。** DOCX 自身是合法 OPC ZIP 容器，但按不支持扩展名处理，**不当成材料 ZIP 继续递归**。

| 归档 | 原始条目路径 | 预期 |
| --- | --- | --- |
| 深度 1 | `nested/unit-01.zip` | 递归到深度 2，3 条目 |
| 深度 1 | `materials/conjugate.pdf` | 1 页，公式参考 |
| 深度 1 | `materials/questions-and-answers.pdf` | 2 页：第 1 页题目 1、2，第 2 页答案重新编号 1、2；2 道题、4 次题号出现，不可误计为 4 道题 |
| 深度 1 | `materials/image-only.pdf` | 1 页，整页内容只有灰度 Image XObject；位图画有 `SCAN 01` 和 `1. 2+2=?`；无字体、无文字层，需要 OCR |
| 深度 1 | `unsupported/notes.docx` | 合法最小 DOCX，`reject / unsupported_extension` |
| 深度 1 | `__MACOSX/._conjugate.pdf` | `ignore / macos_metadata`，不能按扩展名误当 PDF |
| 深度 1 | `.DS_Store` | `ignore / macos_metadata` |
| 深度 1 | `../x.pdf` | 负向安全夹具，实际载荷为合法 1 页 PDF；`reject / path_traversal`，不计入接受页数 |
| 深度 2 | `资料/练习.pdf` | 1 页练习；文件名是真 GBK 字节 |
| 深度 2 | `lectures/overview.pdf` | 2 页讲义 |
| 深度 2 | `__MACOSX/.DS_Store` | `ignore / macos_metadata` |

共 **2 个材料归档，11 条目（外 8、内 3），5 个接受 PDF / 7 页，3 个忽略项、2 个拒绝项**。manifest 记录的是后续导入流程的测试预期，**不代表已有产品导入器执行了拒绝/分类**。

GBK 路径 `资料/练习.pdf` 的文件名字节为 `d7cac1cf2fc1b7cfb02e706466`；本地文件头与中央目录都清除 UTF-8 bit 11，且没有可覆盖解码的 Unicode extra field。测试用 Node ICU 的 GBK 解码器和 JSZip 交叉核对，不以 UTF-8 中文文件名冒充 GBK。macOS 元数据内容只是占位字节，用来测试名称过滤；不声称它们是真实 Finder/AppleDouble 数据库。

### 共轭横线的可核对真值

`conjugate.pdf` 第 1 页显示 **z + 3z̄ = 4 + 2i**，答案 **z = 1 − i**。

- `z̄` 为可见 Type3 字形：线段画 z，额外矩形画其上方横线；不是仅靠元数据或不可见文字声称存在横线。
- 同一字形的 ToUnicode 映射为 `U+007A U+0304`。这样 PDF.js 的真实文本提取与实际图形可分别核对。
- manifest 的 `math.glyph` 记录 PDF 坐标（左下原点）、字号和字形横线区域。测试实际渲染该页，检查横线区域有深色像素、横线与 z 之间留白，且 z 本体存在；还代回解验证实部/虚部等式。
- 这是最小可核对样例，不代表已覆盖真实 PDF 的所有字体、数学排版、Unicode 丢失或 OCR 误识别。

## 行为验证

`verify.mjs` 用**已有声明/锁定**的 JSZip 和 PDF.js（`apps/web` 依赖）读取实际生成字节。PDF.js 的 Node 渲染需其 optional dependency `@napi-rs/canvas`；正常安装请不要 omit optional dependencies。生成器不依赖这些包。缺包时验证明确失败，不跳过或伪造解析结果。

```sh
# 单独检查已生成的产物，无数据库操作
node scripts/run-heavy.mjs node tests/fixtures/sprint-pack/verify.mjs
# 可选：指定先前 --out 目录
node scripts/run-heavy.mjs node tests/fixtures/sprint-pack/verify.mjs /tmp/sprint-pack-opt00

# 无 DB 的夹具专用近测：执行同一个 integration 测试文件，不加载根全局 setup
node scripts/run-heavy.mjs node node_modules/vitest/vitest.mjs run \
  --config tests/fixtures/sprint-pack/offline.vitest.config.mjs

# 限定范围类型与 lint 检查
node scripts/run-heavy.mjs node node_modules/typescript/bin/tsc \
  -p tests/fixtures/sprint-pack/tsconfig.json --noEmit
node scripts/run-heavy.mjs node node_modules/eslint/bin/eslint.js \
  tests/fixtures/sprint-pack/*.mjs tests/integration/sprint-pack-fixtures.test.ts
```

正常 CI 仍由现有 root integration glob 收集 `tests/integration/sprint-pack-fixtures.test.ts`，未改 CI 或全局数据库门禁。由主线程准备**隔离原生 PostgreSQL** 并设置 `OPENING_TEST_DB=1`、`OPENING_TEST_DATABASE_URL` 后运行：

```sh
npm run test:integration -- tests/integration/sprint-pack-fixtures.test.ts
```

根 integration 的 `scripts/opening-test-db.mjs` 会检查 loopback/库名并执行迁移；专用离线配置只检查夹具，**不等于通过根 integration 数据库初始化或产品整包导入**。不要读取现有应用 `.env` 借用数据库，不用 PGlite 替代原生 PG。

测试包含：

- 不同进程、输出路径和时区下同 seed 的 ZIP/manifest 完全一致；不同 seed 的 ZIP 不同。
- 真实中央目录/本地头检查，JSZip 解码、CRC 验证、内外归档结构、manifest 字节数与哈希核对；实际破坏载荷后 CRC 必须失败。
- 真 GBK 文件名字节与 flag 检查；接受 PDF 的真实页树、页面尺寸及绘图指令解析。
- 同文件题目/答案重复题号、共轭 Unicode/横线渲染、图片 PDF 无文字层/实际 Image XObject 解码与渲染。
- `../x.pdf` 原始危险路径保留（JSZip 会把自己的可见 key 规范成 `x.pdf`，因此同时检查 `unsafeOriginalName` 与原始头），DOCX 内部 OPC 条目可读取；确认生成/校验不落盘归档成员。

### 本地依赖与共享锁

如果共享工作区的 `node_modules` 不完整，可在**仓库外隔离目录**安装 package/lockfile 已有版本，并设置 `SPRINT_FIXTURE_PDFJS_ROOT=/绝对路径/node_modules/pdfjs-dist` 供验证器加载。不要为运行这些夹具修改 package/lockfile。该 override 只选择 PDF.js 模块，不执行安装或网络请求；正常 CI 不需要。

若现有 `/tmp/hermes-project-heavy.lock` 为只读，允许对**同一 inode** 用只读文件描述符取得排他 `flock` 后调用原 wrapper；必须先真正拿锁，不能改锁路径、删除锁或无锁设置 `HERMES_HEAVY_LOCK_HELD=1`。其他验证占锁时等待，不能绕过。

## 安全与未覆盖范围

- ZIP 中有故意的 `../x.pdf`；**不要对整个夹具做不受控 unzip/extractAll**。这里只内存读取，并只写固定 `sprint-pack.zip`、`manifest.json`。
- 不实现真实导入、分类器、路径拒绝器、上传、数据库写入、OCR 服务或模型调用；预期拒绝原因是未来消费者应满足的验收数据。
- PDF.js 离线软件渲染不是浏览器验收，也不是生产 Worker/OCR 或真实材料学习效果验收。
