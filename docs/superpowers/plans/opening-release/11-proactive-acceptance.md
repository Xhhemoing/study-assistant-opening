# Proactive Study/Life Assistance and Expanded Acceptance Implementation Plan

> **For agentic workers:** Use executing-plans task-by-task. Run the failing tests before implementation; preserve evidence boundaries at handoff.

**Goal:** 把多源通知、课程资料和学习反馈变成少量可执行行动，减少日常规划与选择成本，并验收全部新增需求。
**Architecture:** 汇总到已有T03候选、M01作用域记忆和P02协商计划；U04统一呈现连接/知识/建议状态，不增加一套孤立待办系统。
**Tech Stack:** 既有TypeScript领域规则、Next.js/Tailwind界面、PostgreSQL、Vitest/Playwright；无新调度器服务。

## Global Constraints

默认至多三个优先行动。自动整理不等于自动承诺；高影响改期、新数据源授权、外发/删除仍需确认。没有确定时间不造截止，没有可用时间不占睡眠。倾诉不是待办，拒绝不是人格。
参考[补充规格](../../specs/2026-09-14-learning-capability-expansion.md)、[X01接口](capability-interfaces.md)；现有M0–M4属于基础交付，本计划Q04才覆盖CAP01–06。

### P04: Multisource candidate consolidation and low-choice planning

**Owner:** AI+EXPERIENCE. **Depends:** C02,C03,K02,P02,M01.
**Create:** `packages/domain/src/opening/action-digest.ts`、`action-digest.test.ts`；`apps/worker/src/jobs/extract-study-actions.ts`；`apps/web/src/features/opening/planning/action-service.ts`；`apps/web/src/app/api/opening/action-digest/route.ts`；`tests/integration/opening-action-digest.test.ts`。
**Modify:** T03候选接受/拒绝与P02计划服务，仅增加来源修订与重排适配；不得静默改变旧API的确认含义。
**Interfaces:** `buildActionDigest(candidates:ActionCandidate[]):ActionDigest`；提取worker从授权ImportReceipt与课程chunks输出候选，不能直接生成accepted任务。

- [ ] 写完整候选fixture，验证拒绝后不再推送：
```ts
it('does not re-prompt a rejected suggestion', () => {
  const c={id:'c',dedupeKey:'mail-1:deadline',title:'作业',minutes:30,dueAt:null,priority:1,sourceIds:['s'],status:'rejected' as const,needsConfirmation:true};
  expect(buildActionDigest([c])).toEqual({primary:[],pendingConfirmationCount:0});
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/action-digest.test.ts`确认红灯；补上重复来源、修订、3项限制、已完成与空列表。
- [ ] 将邮件/钉钉通知及课程资料提取为课程关联、活动、作业/考试截止候选。日期需按来源发送时间、用户时区解析；“下周”缺锚点或邮件只是转发则needsConfirmation；不得用同步日期冒充通知日期。
- [ ] 来源revision+语义事实key用于修订与去重；重复通知不再问，更正通知使旧候选superseded，已接受安排只提出差异草案。跨来源疑似重复但证据不足时集中确认，不错误合并两个不同作业。
- [ ] 纳入K02明确学习卡点、到期复习和用户确认的生活安排/可用时间，调用P02排程；默认提供一份推荐计划而非多方案选择墙。详细理由可展开；超容量列出未安排项并给可拒绝的拆分/延期建议。
- [ ] 同命令复测及`npm run test:integration -- opening-action-digest`：接受幂等、来源更正、旧计划409、撤销数据源晚到建议被拒、疲劳过期、不强排休息。记录每次需要用户确认的原因，用真实场景检查是否比手工整理减少操作，不预设节省百分比。

### U04: Connection controls, knowledge view and one daily action surface

**Owner:** EXPERIENCE. **Depends:** C02,C03,V01,K02,P04.
**Create:** `apps/web/src/features/opening/connections/connection-settings.tsx`、`connection-status.tsx`；`apps/web/src/features/opening/knowledge/course-knowledge.tsx`、`knowledge-evidence.tsx`；`apps/web/src/features/opening/planning/action-digest.tsx`；`apps/web/src/features/opening/sources/media-reader.tsx`；`apps/web/src/app/(opening)/opening/settings/connections/page.tsx`；`tests/e2e/opening-capabilities.spec.ts`、`opening-capability-fixture.ts`。
**Modify:** 既有今天/助理/课程入口与API client，用真实API消费X01数据；组件拆分≤200行，不全量重做旧平台导航。
**Interfaces:** 复用X01所有GET输出；fixture `seedCapabilityAccount(request:APIRequestContext):Promise<{cookie:Cookie;connectionId:string;courseId:string;dispose():Promise<void>}>`创建隔离账号/真实DB来源，Cookie使用Playwright上下文cookie结构，不通过page.route伪造业务API。

- [ ] 写浏览器失败测试：
```ts
test('shows authorization failure rather than a working connector', async ({page,request}) => {
  const f=await seedCapabilityAccount(request);
  try {
    await page.context().addCookies([f.cookie]);
    await page.goto('/opening/settings/connections');
    await expect(page.getByText('等待授权',{exact:true})).toBeVisible();
  } finally { await f.dispose(); }
});
```
fixture通过C01创建未授权连接，不携带真实学校凭据；测试文件导入Playwright test/expect及fixture。
- [ ] 运行`npm run test:browser -- tests/e2e/opening-capabilities.spec.ts`确认红灯，再实现界面。
- [ ] 连接页展示授权范围/同步时间/错误/暂停/撤销；邮箱secret不回显，安全提交后清理表单。手工导入明确标记手工，不能伪装自动同步。
- [ ] 课程页先展示章节和下一步，知识关系为展开层；点知识点可回到课件页、视频时间、题目与证据。原件已保存但解析失败、仅音频转写和视觉覆盖不足各有独立状态。
- [ ] 今天默认≤3行动与一张集中确认卡，支持接受、修改、拒绝及查看依据；未排任务与过期草案可见。390x844与1440x900、键盘焦点、长标题、视频定位、断网/刷新跨端恢复都走真实API。
- [ ] 同命令复测，补手机真实文件选择和跨端恢复截图；未配置服务显示不可用而非示例内容。界面验收不替代邮箱/模型/视频质量验收。

### Q04: Expanded capability acceptance, privacy recovery and release evidence

**Owner:** QA+INTEGRATOR. **Depends:** U04,Q02.
**Create:** `tests/integration/opening-capability-privacy.test.ts`；`tests/e2e/opening-multisource-loop.spec.ts`；`tests/evaluation/opening-capability-cases.json`；`docs/superpowers/evidence/opening-capability-acceptance.md`。
**Modify:** `packages/database/src/repositories/opening-backup.ts`、`scripts/opening-restore.ts`、`infra/docker/compose.opening.yml`、`docs/operations/opening-release.md`；备份版本增量增加0021–0023及媒体对象，凭据始终排除，恢复后连接disabled。
**Interfaces:** 沿用Q03备份白名单/删除日志和Q02评价命令；扩展case标记CAP01–06、inputProvenance、expectedResult、actualResult、status(pass/fail/blocked)、artifactPath。此处为计划，证据文档只在实际运行时填结果。

- [ ] 先写删除/恢复失败测试：授权邮件被导入→撤销并删除→导出旧备份→新空测试库恢复；断言正文、附件、转写、知识引用不可复活，连接不自动重连；不同workspace不得看到正文/图谱。
- [ ] 执行`npm run test:integration -- opening-capability-privacy`红灯后完善恢复适配；密钥不包含在备份中，连接配置不等于重新授权，恢复队列保持cancelled。
- [ ] 浏览器链`npm run test:browser -- tests/e2e/opening-multisource-loop.spec.ts`：授权测试通知→附件归课→知识点引用→提示后练习→独立新题→延迟重测→今日建议→确认→新设备继续。离线fixture和真实学校/组织样本分别记录，不混成一次通过。
- [ ] 场景金标至少覆盖：邮件字符集/重复/更正/附件、钉钉无权限与获准样本、静音板书视频、噪声录音、含糊公式、先修循环、提示曝光、没有可用时间、拒绝建议、撤销晚到任务、备份恢复。缺平台权限则CAP02实接blocked，不以截图上传冒充。
- [ ] 报告功能与效果分开：协议/权限确定性门禁、知识引用语义、个人新题/延迟表现、耗时和费用各有样本来源与分母。自动转写/知识结构/主动辅导是CAP03–05必须项，不得默认以原件存储/普通聊天替代；确需缩减须用户重新确认。
- [ ] 验收按现有安全Git流程运行lint/typecheck/unit/contract/handler/integration/browser/build；CI/PR附证据，购买、真实部署和生产迁移仍另行授权。回滚停止新增连接/媒体/知识任务，回退入口并保留新表/对象；恢复使用隔离验证过的备份，不删除原件或凭据墓碑。

**Release decision:** M4仅代表原五项基础闭环；M5只有CAP01–06的实际目标和隐私/恢复门禁满足才可宣称全面覆盖。用户批准的临时降级必须逐项列出，不能静默改变范围。
