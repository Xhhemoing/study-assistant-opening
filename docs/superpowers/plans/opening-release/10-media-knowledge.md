# Multimodal Course Knowledge and Adaptive Tutoring Implementation Plan

> **For agentic workers:** Use executing-plans task-by-task; first write and run the specified failing tests, then implement and recheck.

**Goal:** 从课件、视频、录音和作答构建可追溯的课程知识结构，持续更新学习证据并安排针对性辅导。
**Architecture:** 复用原件/SourceChunk管线；FFmpeg与faster-whisper作为受限转换适配，知识关系和技能证据保存在既有PostgreSQL。DeepTutor只作为流程与可选模块参考，不复制整套应用。
**Tech Stack:** TypeScript、Python隔离解析环境、Docling、FFmpeg、faster-whisper、PostgreSQL、既有模型预算适配。

## Global Constraints

遵循[范围补充](../../specs/2026-09-14-learning-capability-expansion.md)和[共享协议](capability-interfaces.md)。原件保存不等于音视频理解；知识点被提取不等于学生掌握。
每种能力选一个默认工具，实际制品/模型许可与资源限制验证后启用。不上传到外部转写服务，除非用户另行批准预算和数据范围。公式、噪声、口音不清晰时保留needs_check并提供定位。

### V01: Audio transcription and video/audio-slide alignment

**Owner:** PIPELINE. **Depends:** X01,I02,I03.
**Create:** `apps/worker/src/parsers/media-process.ts`、`media-segments.ts`、`media-segments.test.ts`；`apps/worker/src/jobs/parse-media.ts`；`services/parser/opening_parser/media.py`、`transcribe.py`、`tests/test_media.py`；`tests/fixtures/opening/media/README.md`；`apps/web/src/app/api/opening/sources/[id]/segments/route.ts`、`segments/corrections/route.ts`（后一条同source目录）。
**Modify:** `services/parser/pyproject.toml`、`model-manifest.json`；I03的`apps/worker/src/runtime/handlers.ts`注册受限媒体任务，不另外启动业务后端。
**Interfaces:** `validateMediaSegments(segments:MediaSegment[],durationMs:number):MediaSegment[]`；`extractMedia({path,mime,maxDurationMs},signal):Promise<MediaSegment[]>`；source/version必须由服务端加载，不能由模型决定。

- [ ] 写时间戳失败测试：
```ts
it('rejects segments outside the source duration', () => {
  const s={sourceId:'s',sourceVersion:1,startMs:0,endMs:1001,text:'课程',frameChunkIds:[],quality:'needs_check' as const};
  expect(()=>validateMediaSegments([s],1000)).toThrow();
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/parsers/media-segments.test.ts`确认失败。
- [ ] 使用FFmpeg/ffprobe的argv调用（无shell插值），禁止网络协议输入；对上传实际容器、时长、尺寸及音轨验证。视频512MiB/120分钟，超过限制返回明确错误；内存/CPU/超时由worker配置硬限，不一次性加载媒体入Web内存。
- [ ] 音轨交给faster-whisper；视频额外按场景变化提取关键帧，设上限每分钟2帧/单文件120帧，超限显示视觉覆盖受限。对关键帧复用I02版面/图像路径，保留原时间；不能把只转写声音宣传成理解板书/静音课件。
- [ ] 定义可重复Python测试：一段合成视频含静音板书帧、一段带噪音轨；校验音轨存在/缺失、帧时间、坏容器、超长拒绝和取消清理。执行`python -m pytest services/parser/tests/test_media.py`。不预填识别准确率。
- [ ] 用户纠错生成新source版本并使旧转写派生节点失效，重跑仅受影响范围；不覆盖原件或已保存旧引用。记录模型版本、实际语言、耗时、峰值内存；不自动下载未知权重。
- [ ] 重跑两组测试，并以经授权真实课堂片段验收“转写定位→播放原片段→关键帧/课件引用→提问”。无法理解视觉或转写不达标单列blocked，不把I02的原件保存当作V01通过。

### K01: Source-backed, editable course knowledge structure

**Owner:** AI+DATA. **Depends:** X01,C01,I02,T02.
**Create:** `packages/contracts/src/opening/knowledge.test.ts`；`packages/domain/src/opening/knowledge-graph.ts`、`knowledge-graph.test.ts`；`packages/database/src/schema/opening-knowledge.ts`、`repositories/opening-knowledge.ts`、`migrations/0022_opening_knowledge.sql`；`apps/worker/src/jobs/build-course-knowledge.ts`；`apps/web/src/features/opening/knowledge/service.ts`；`apps/web/src/app/api/opening/courses/[id]/knowledge/route.ts`、`knowledge/rebuild/route.ts`；`tests/integration/opening-knowledge.test.ts`。
**Interfaces:** `validateKnowledgeSnapshot(snapshot:KnowledgeSnapshot):KnowledgeSnapshot`；CRUD/rebuild遵守X01的expectedVersion与授权引用验证。SourceChunk来自文档或V01时间段，题型节点通过SkillEvidence连接练习，不以自由文本技能名作为永久唯一ID。

- [ ] 在完整fixture上增加无依据节点和循环先修的失败测试：
```ts
it('rejects a self prerequisite', () => {
  const n={id:'n',courseId:'c',label:'函数',kind:'concept' as const,evidenceChunkIds:['chunk'],status:'supported' as const};
  expect(()=>validateKnowledgeSnapshot({courseId:'c',version:1,nodes:[n],edges:[{from:'n',to:'n',kind:'prerequisite',evidenceChunkIds:['chunk'],status:'supported'}]})).toThrow();
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/knowledge-graph.test.ts`确认失败。
- [ ] 用T02已授权chunks提取章节/概念/方法/题型与证据；LLM输出先过结构校验，再按实际source版本、course membership核对引用。无材料的先修推断标suggested，不伪造原文证据；含糊公式不入supported。
- [ ] 自动形成可用目录与关联；仅歧义合并、冲突和关键修订请求用户确认，不让用户逐节点维护。含义相近不直接合并；保留别名/来源差异、人工纠正和版本记录。先修边拒绝循环，其他关系不误用DAG限制。
- [ ] 0022在C01的0021后迁移；保存节点/边/快照及来源版本。新材料增量补充，资料撤销或纠错仅使相关推断needs_check；原个人作答历史保留，但不可继续作为已删除来源的可见引用。支持跨课程关联但权限仍逐源校验。
- [ ] 重跑单测、`npm run test:integration -- opening-knowledge`：重复提取幂等、非法引用、跨课程越权、循环、人工更正不被覆盖、删除/重建竞态。人工审查一门课的章节覆盖、关键先修和引用支持度，记录分母；不凭图形漂亮认定知识结构正确。
- [ ] 回滚关闭知识构建任务与读入口，保留新增表和原始资料；不可降级到无引用生成图，数据库恢复走Q03。

### K02: Skill-linked evidence, targeted tutoring and retest feedback

**Owner:** EXPERIENCE+AI+DATA. **Depends:** K01,L02,T03.
**Create:** `packages/domain/src/opening/tutor-policy.ts`、`tutor-policy.test.ts`；`packages/database/src/repositories/opening-skill-evidence.ts`、`migrations/0023_opening_skill_evidence.sql`；`apps/web/src/features/opening/learning/tutor-actions.ts`；`apps/web/src/app/api/opening/courses/[id]/tutor-actions/route.ts`；`tests/integration/opening-adaptive-loop.test.ts`。
**Modify:** L01 observation service、L02 retest worker、T03 tutor worker（各自小适配模块，不继续扩大超过200行的文件）。
**Interfaces:** `recommendTutorAction({nodeId,hasCheckedIndependent,hasAssistance,retestDue}):TutorAction['kind']`；服务端从SkillEvidence/Observation加载标志，客户端不可自报已核验独立。

- [ ] 写帮助曝光不能被误当独立掌握的失败测试：
```ts
it('asks for independent transfer after assisted success', () => {
  expect(recommendTutorAction({nodeId:'n',hasCheckedIndependent:false,hasAssistance:true,retestDue:false})).toBe('independent_variant');
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/tutor-policy.test.ts`确认失败。
- [ ] 明确决策顺序：到期重测→delayed_retest；已受帮助但未独立核验→independent_variant；无可靠证据→clarify；已有独立证据→新情境independent_variant。worked_example/guided由当前卡点、用户请求及已确认学习偏好选择，不强迫初学者先答题。
- [ ] 关联回忆/解释/程序执行/迁移/限时维度、题目身份、提示曝光、用时及参考核验；未知时间和自报正确不升级证据。生成题和答案需校验、标生成；无法可靠核验的证明题保持needs_check，不宣布掌握。
- [ ] 复用L02重测队列、T03材料辅导和P02候选任务，不另造评分系统。完成重测关闭对应due项、追加新证据并更新下一步建议；同题复述、看答案后答对、新题独立和延迟表现分开。用户可纠正错因；不要把OCR错误算学科错误。
- [ ] 重跑单测和`npm run test:integration -- opening-adaptive-loop`，验证“提示→新题→延迟→更新计划候选”及跨技能不污染。效果报告比较独立新题、延迟正确率、提示依赖和耗时，保留样本量/难度差异；不作因果疗效或全面提分保证。
- [ ] 0023追加SkillEvidence关联，保持LearningEvent v1兼容。回滚停用新投影，保留L01原始观察与既有辅导功能，不删除学习历史。
