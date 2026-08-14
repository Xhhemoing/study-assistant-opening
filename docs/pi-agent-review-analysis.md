# Pi Agent 操作审查与自优化逻辑分析

> 生成日期: 2026-08-13  
> 审查范围: AIstudy 项目 + cengfan-ai-production-hardening + better-harness + pi 核心

## 一、当前 Pi Agent 在本项目的操作概览

### 1.1 项目级配置 (`.pi/`)

| 组件 | 数量/内容 | 评价 |
|------|-----------|------|
| 自定义 Agents | 4 个 (scout, planner, worker, reviewer) | ✅ 职责分离清晰,worker 有完整工具集 |
| Subagent Extension | 1 个 (extensions/subagent) | ✅ 支持 single/parallel/chain 模式,流式更新完善 |
| Workflow Prompts | 5 个 (implement, scout-and-plan, aistudy-implement 等) | ✅ 覆盖常见场景 |
| Better-harness Reports | 2 轮 (145008, 145448) | ⚠️ 证据边界限制,多数维度仍为 "not observed" |

### 1.2 项目级技能 (`.agents/skills/`)

| 技能 | 状态 | 问题 |
|------|------|------|
| aistudy-git-workflow | 已配置,trigger/procedure/output/validation 全齐 | ❌ 实际路由调用证据为 0 |
| impeccable | 已配置 | ⚠️ 仅 UI 场景使用,未见系统性审计记录 |

### 1.3 指令覆盖

| 范围 | 文件数 | 覆盖率 |
|------|--------|--------|
| 根 AGENTS.md | 1 | - |
| 包级嵌套 AGENTS.md | 7 (apps/web + 6 packages) | 从 0% → ~2% (409 源文件) |
| 全局技能 | 22 个 (位于 `~/.agents/skills/`) | - |

**Better-harness 改进效果**:
- Task-understanding: 66 → 74
- Controlled-execution: 64 → 68  
- Learning-capture: 38 → 44
- Reliable-delivery: 维持 45 (无实际交付证据)

## 二、跨项目 Pi Agent 配置对比

### 2.1 cengfan-ai-production-hardening (worktree)

**亮点**:
- AGENTS.md 包含完整的验证纪律与交付纪律(与 AIstudy 一致)
- 自定义技能 `cengfan-data-import` 针对导入导出场景
- `.pi/` 目录存在,推测有 subagent 配置

**差距**:
- 技能数量少于 AIstudy
- 无 better-harness 报告

### 2.2 better-harness (QoderAI/better-harness)

**亮点**:
- 4 个 harness 专用技能 (harness-skill-creator, skill-review, change-traceability-review, triangulate-spec-review)
- 详细的 AGENTS.md,包含 spec 流程、变更范围、主机适配器约束
- 文档链接完整性测试 (`test/doc-link-graph.test.mjs`)
- findings-recommend 脚本

**差距**:
- 作为 meta harness,未见自我审查报告
- 技能创建流程复杂,需多跳引用

### 2.3 Pi 核心 (pi-coding-agent npm 包)

**现状**:
- 位于全局 npm 模块,无项目级 `.pi/` 或 `.agents/`
- 文档与示例在 `examples/extensions/`
- 技能为用户级 `~/.agents/skills/`

**问题**:
- Pi 自身无 AGENTS.md
- 无 harness 自检机制

## 三、自优化逻辑的不足

### 3.1 证据边界 (Evidence Boundary) 问题

**现象**: Better-harness 报告中 80%+ 维度标记为 "not observed in this boundary"

**根因**:
1. 反馈循环依赖"实际使用证据",但会话日志未系统性捕获
2. 技能路由成功/失败无结构化埋点
3. 交付决策 (PR/CI) 发生在 agent 会话之外

**影响**: 学习维度长期停滞,无法区分"配置正确但未触发" vs "配置错误"

### 3.2 跨项目知识孤岛

**现象**: 每个项目的 `.pi/` 和 `.agents/` 相互独立

**缺失**:
- 无机制将 AIstudy 的 `aistudy-git-workflow` 推广为全局技能
- 无机制将 cengfan 的 `cengfan-data-import` 共享
- 全局 `~/.agents/skills/` 与项目级 `.agents/skills/` 无同步策略

### 3.3 缺少元技能 (Meta-skill)

**缺失场景**:
- 当多个项目反复出现相同摩擦时,无技能触发"提出 harness 级修复"
- 无技能分析"哪些场景下 agent 应该调用技能但实际未调用"

**建议**: 新增 `harness-friction-analyzer` 技能,输入多项目 better-harness 报告,输出全局改进提案

### 3.4 验证纪律的执行 gap

**现象**: AGENTS.md 已写入 `failure → cause → fix → recheck`,但无证据证明被实际遵循

**验证方法缺失**:
- 无结构化完成报告模板强制要求四步证据链
- 无 lint 规则检查提交信息是否包含根因

### 3.5 交付维度 (Reliable-delivery) 结构性瓶颈

**分数长期 45** 的原因:
- CI workflow 存在但 agent 会话中无 PR 决策记录
- 验收/回滚路径在 GitHub PR 界面而非 agent 上下文
- 无法在 agent 证据边界内观察到交付事件

**可能解法**: 将 PR 模板、合并策略纳入 agent 提示,或通过 GitHub API 工具让 agent 直接创建 PR

### 3.6 技能路由的可观测性不足

**问题**:
- `scenario-skill-router` 描述"当任务匹配场景时加载",但无日志记录实际加载了哪些技能
- 无法回答"本会话中哪些技能被激活、哪些被跳过"

### 3.7 负面案例捕获缺失

**现状**: 系统记录"技能已路由"(正面),但不记录"本应路由但未路由"(负面)

**影响**: 无法训练 router 改进触发条件

## 四、改进建议

### 4.1 短期 (本项目内)

1. 为 `aistudy-git-workflow` 添加调用日志埋点,验证是否被 router 触发
2. 在 AGENTS.md 增加"完成报告模板"章节,强制要求四步证据链
3. 将 better-harness 报告归档到 `docs/harness-reports/` 并建立趋势分析

### 4.2 中期 (跨项目)

1. 建立 `~/.agents/skills/shared/` 目录,存放可跨项目复用的技能
2. 开发 `pi skill sync` 命令,在项目间同步共享技能
3. 为 better-harness 增加 `--trend` 模式,对比多轮报告

### 4.3 长期 (harness 级)

1. 在 pi 核心增加 `harness-self-review` 扩展,定期对自身配置做 better-harness 分析
2. 实现技能路由埋点 SDK,所有技能调用自动记录到 `.pi/logs/skill-routes.jsonl`
3. 新增元技能 `harness-friction-analyzer`,输入多项目报告,输出全局改进提案

## 五、提交计划

**目标分支**: `feat/pi-agent-review-analysis`

**变更文件**:
- `docs/pi-agent-review-analysis.md` (新增)
- `project/` 目录 (同步快照,供离线分析)

**验证命令**:
```bash
npm run lint -- docs/pi-agent-review-analysis.md 2>/dev/null || echo "no lint for md"
git diff --stat
```

**风险**:
- `project/` 目录包含完整源码副本,体积较大,需评估是否纳入提交
- 分析文档涉及敏感路径 (`C:\Users\86080\.pi\...`),已脱敏处理
