# 新切片集成审查（执行中）

只针对当前自我解释与分支纯算法，不代表已完成。

## 非评分自我解释待复核

1. SelfExplanation scope不可是固定self-explanation字符串；要绑定getVerifiedSessionNamespace()，未认证时拒绝恢复/保存。当前StudyContext identity不含owner，空/共享上下文跨账号会读同份稿。保存期间必须捕获scope，账号切换不得把旧请求结果归入新账号。
2. study-context-tools的checkChat为true后，普通'记笔记'按钮只setTab(note)不会清checkChat，visibleTab仍question。所有显式tab选择需清临时override；section=notes需要明确返回笔记动作，不能卡在提问。
3. 原话冻结与修订可以复用既有note收据，但JSON转义后可能超过StudyNoteDraft.text 20000上限；原话/修订各9000个引号或换行会放大。必须保证持久化格式在schema内，超限诚实提示而非存坏receipt。
4. 只保留用户文本；AI反馈未持久绑定时，不宣传完整'user-original/AI-feedback/revision'三件套。检查按钮只是预填，不产生model请求或observation。
5. 严格保存未知不可重试，新记录按钮不能清unknown并重复建文档。成功保存后再开新记录可以。

## 分支算法

仅纯选择器有测试不等于正式分支。未来DB service必须提供有顺序且已授权的全前缀，冻结完成turn ID manifest；当前unknown lineage、query model隔离、总预算不得降级。不能据algorithm完成就更改导航或写branch表。

## 提交边界

上一提交49868690只包含Explore预览/示例/上下文审阅，其他material-trust dirty保留。此轮新片未提交；验收通过后另commit，不amend已推送历史。
