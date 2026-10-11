# ISOLATION — eval-heldout（硬规则）

**单位：** `rank-nullspace-v1`  
**路径：** `tests/fixtures/opening/teaching/unit-rank-nullspace/eval-heldout/`

## 硬规则

下列 ID / 文件 **不得** 出现在：

1. 教学检索包（teaching retrieval packs）
2. 主讲 / 辅导的 tutor context assembly（讲解、换解释、追问用的材料上下文）
3. `lecture/` fixtures、`materials/` 授权检索列表、`examples/` 的 `exposureClass:"lecture"` 暴露集

它们 **仅** 用于评价 harness（冻结后的独立评测），对照 `retrieval-denylist.json`。

## 什么不算 held-out「迁移」

- 把讲解例换一个引用 ID
- 把矩阵换两个数字却结构同构，并宣传为 transfer
- 在教学活动里「先练一遍」再当作未曝光

**Changing a lecture example number does NOT make it held-out transfer.**

## 机器可读

见同目录 `retrieval-denylist.json`（全部 `problemId` + 路径）。  
教学侧白名单见 `../lecture/retrieval-allowlist.json`。

## 对照

- 评价文档 E4：`docs/quality/teaching-v2-evaluation.md`
- 章程目标 G6（证据诚实）
