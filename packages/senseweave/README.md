# @aistudy/senseweave

SenseWeave Runtime 的原样拷贝，供聊天回答的“分段嵌入”使用。来源、版本与提交号见 `vendor/VENDOR.json`。

- 只通过 `@aistudy/senseweave/host`（决策与切分，纯函数，可在服务端/客户端运行）和 `@aistudy/senseweave/block`（浏览器内挂载单个组件，组件代码首次出现时才加载）使用。
- **不要修改 `vendor/`。** 需要改动时在上游仓库提交，再重新拷贝：

```bash
# 在 SenseWeave 仓库根目录
node scripts/vendor.mjs <AIstudy>/packages/senseweave/vendor
node scripts/vendor.mjs --check <AIstudy>/packages/senseweave/vendor
```

- 许可：上游为 GPL-3.0-only；AIstudy 为 AGPL-3.0-only，二者可依 GPLv3/AGPLv3 第 13 条组合分发。详见 `docs/decisions/` 中的 SenseWeave ADR。
- 开关：`OPENING_CHAT_SENSEWEAVE=off|shadow|on`（默认 shadow：只计算决策，界面不变）。`on` 仍要求账号在服务端 `OPENING_CHAT_SENSEWEAVE_BETA_USERS` 白名单；其余账号保持shadow，匿名off。门控表通过capabilities下发，只收窄教学能力。
- 宿主设置（`apps/web/src/features/opening/assistant/senseweave-host.ts`）：`placement: "replace"`；derivation 仅 explain/derive；手绘仅 explain/review，门控表 `sketch:false` 关闭；不接 AI 辅助。
- CI校验：`node scripts/check-senseweave-vendor.mjs`。测试版接入/回滚和证据边界见 `docs/plans/2026-10-24-senseweave-beta.md`。
