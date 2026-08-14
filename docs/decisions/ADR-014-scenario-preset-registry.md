# ADR-014: ScenarioPreset 注册表（Registry）与数据驱动解耦

**状态**: 接受  
**日期**: 2026-08-14  
**决策者**: 架构团队 / AIstudy 实施子代理

## 背景

`packages/contracts/src/goals.ts` 中的 `scenarioPresetSchema = z.enum(["final","gaokao","kaoyan","custom"])` 将场景预设硬编码为枚举。`packages/domain/src/planning/planner.ts` 中的 `tierOrder(scenario)` 和 `REASON_BY_STATUS` 常量通过 `if/else` 分支实现不同预设的行为逻辑。

这种设计导致：
- 新增预设需修改 contracts 枚举和 planner 条件分支；
- tier 排序和 reason 文案散落在代码中，无法集中版本化；
- 未来将预设存储到数据库或配置中心时，迁移成本高。

## 决策

引入 `ScenarioPresetDefinition` 注册表（`packages/domain/src/planning/scenario-presets.ts`），作为场景行为的单一事实来源：

- `ScenarioPreset` 仍保留 Zod 枚举（向后兼容）；
- 新增 `ScenarioPresetDefinition` 类型，包含 `id`、`version`、`displayName`、`tierOrder`、`reasonByStatus`；
- `getScenarioPresetDefinition(preset)` 返回定义，未知值抛错；
- `listKnownScenarioPresets()` 返回全部已知定义；
- `planner.ts` 改为从注册表读取 `tierOrder` 和 `reasonByStatus`，删除原有硬编码函数和常量。

四个预设的硬编码值：
- `final`: displayName="期末考试", version="1.0.0", tierOrder=["weak","untested","usable"]
- `gaokao`: displayName="高考", version="1.0.0", tierOrder=["weak","usable","untested"]
- `kaoyan`: displayName="考研", version="1.0.0", tierOrder=["weak","usable","untested"]
- `custom`: displayName="自定义", version="1.0.0", tierOrder=["weak","untested","usable"]

## 理由

- **最小侵入**：不扩展枚举、不改公共签名，现有调用方零改动即可获得新行为。
- **可测试性**：注册表可独立单元测试，planner 测试保持断言不变。
- **演进路径**：Phase 2 可将注册表后端改为从 `strategy_presets` 表读取；当前内存 Map 作为清晰的接缝。
- **类型安全**：`tierOrder` 为 `Exclude<StatusWord,"stable">[]`，`reasonByStatus` 为 `Record<Exclude<StatusWord,"stable">,string>`，与 `StatusWord = "stable"|"weak"|"usable"|"untested"` 一致。

## 风险与缓解

- UI 标签可能漂移：Task 5 在 goal-model.ts 增加注释指向注册表作为未来真相来源。
- 未来 DB 迁移：注册表模块可演进为异步工厂，不影响当前同步 API。

## 后续

- planner、mock seeds、provider-plan 均改为从注册表解析；
- 集成测试确认四种预设输出不变；
- 质量门禁（lint、typecheck、test、build）全绿后合并。

## 参考

- 计划文档: `docs/superpowers/plans/2026-08-14-scenario-preset-data-driven-plan.md`
- contracts: `packages/contracts/src/goals.ts`
- planner: `packages/domain/src/planning/planner.ts`
