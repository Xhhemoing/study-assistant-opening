# Opening teaching fixtures（V2-02）

**Owner of content:** AI（教学样本 / 题库 / 答案键 / 未曝光评测隔离）  
**Owner of UX clues:** Experience — 见 `docs/quality/teaching-v2-evaluation.md`（Experience / UI·交互验收，含 Paula「嵌入现有程序 / 非旁路」EX）

## Boundary

本目录用于 **M0 教学单元与评测样本**（计划拟路径）。Experience **不**在此发明完整 item bank；仅维护本 README 边界说明。

| 放这里（AI） | 不放这里 |
|---|---|
| 秩与零空间讲解素材、正例、典型错误 | 生产 React / worker / database 代码 |
| 未曝光 hold-out 题（须与教学检索包隔离） | 平行「第二套掌握分」假数据 |
| 符号约定、可接受表达、未能核验项 | Experience 浏览器步骤正文（在 docs/quality） |

## Layout note（AI 正在落盘时可演进）

当前可见（Experience 不修改其内容）：

- `unit-rank-nullspace/` — 首单元样例根（goals / materials / lecture / examples / …）
- `unit-rank-nullspace/eval-heldout/` — **未曝光评测**；不得进入教学检索 / 聊天材料 picker（对照评价文档 E4）

具体文件与答案键由 AI 维护。

## Isolation reminder（V2-02 验收）

- 未曝光评测题 **不得** 进入教学检索 / 聊天材料选择器默认包。
- `eval-heldout`（或等价 manifest 字段）与 `lecture` / `materials` 必须隔离。

## Related

- 评价与 UI 线索：`docs/quality/teaching-v2-evaluation.md`
- 计划：`docs/superpowers/plans/ai-led-learning-v2/plan.md`（V2-02、§5.1–5.3）
- Experience 证据：`docs/superpowers/evidence/2026-10-11-opening-release/v2-02-experience-ui-acceptance-implement.md`

---

## AI unit inventory（rank-nullspace-v1）

> 以下由 **AIstudy AI** 追加；上方 Boundary / Isolation / Related 为 Experience 边界说明，保留不删。

**单元根目录：** `unit-rank-nullspace/`  
**unitId：** `rank-nullspace-v1`  
**baselineTip：** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**评价文档：** `docs/quality/teaching-v2-evaluation.md`（AI 区 + Experience EX/E0–E9）

### 目录要点

| 路径 | 用途 |
|---|---|
| `manifest.json` | 单元元数据、检索策略、样本计数 |
| `symbols.md` | 符号约定权威 |
| `materials/` | 5 则可授权讲解原材料 + `sources-index.json` |
| `goals/teaching-goals.json` | 教学目标 G-RN-01…06 |
| `examples/correct-examples.json` | 讲解正例（exposureClass=lecture） |
| `examples/typical-errors.json` | 典型错误 |
| `lecture/` | §5.3 活动提纲 + 检索白名单 |
| `eval-heldout/` | **未曝光**题 + denylist + `ISOLATION.md` |
| `anomaly-cases/cases.json` | 异常夹具 |

### 工程样本计数（非功效分析）

| 类别 | 数量 |
|---|---|
| materials sources | 5 |
| chunks（sources-index chunkHints） | 14 |
| correct examples | 12 |
| typical errors | 10 |
| heldout problems | 15 |
| anomaly cases | 9 |
| **countable total**（chunks+examples+errors+heldout+anomalies） | **60** |

### 隔离指针

- 白名单：`unit-rank-nullspace/lecture/retrieval-allowlist.json`
- 黑名单：`unit-rank-nullspace/eval-heldout/retrieval-denylist.json`
- 硬规则：`unit-rank-nullspace/eval-heldout/ISOLATION.md`
- held-out problemId **不得**出现在教学检索；改讲解例数字 ≠ transfer

### 内容性质

全部为 **合成教学夹具**，无真实学生作答或隐私数据。扩展新单元时：复制目录结构、更新 `manifest.json` counts、保持 eval-heldout 与 lecture allowlist 互斥，并在评价文档样本清单登记。
