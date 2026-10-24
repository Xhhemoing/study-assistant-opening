# 第一阶段主代理验收问题（实现中）

此文件是给阶段1后续修复的具体任务，不代表已通过。

## 已执行

- 37项定向UI/状态/会话测试：22通过、15失败，根因React18下从react导入act不可用。已派独立测试修复代理，保留所有行为断言。
- Web类型首次被锁文件权限拒绝；同inode共享锁已修组权限，没有关闭串行保护。第二次因另一个发布构建占锁超时退出75，未执行类型检查，不算代码失败或通过。

- 新增预览/demo/API/database helper共14文件的TypeScript transpile语法检查0错误；仅语法，不等同typecheck或运行验证。
- 第二轮UI已修React18 act导入，重跑尚在共享锁队列；当前另一个发布的Next构建占锁，不终止别人的构建、不换锁绕开。

## 收口代码已落地（待完整运行回归）

- response严格schema、请求/locator/receipt身份验证、有效回复后ACK、clientKey119边界已实现。
- 服务扩展为同页有限段落原文，保留原选区与expanded/truncated，不再仅回显短词；幂等fingerprint包含两者。
- UI已展示资料名/页码，将ID移入诊断；披露扩展与截断，继续问只用原选区，loading禁发送。
- LearningProse已增加可选可信候选概念锚点与AST测试；默认无候选不改输出。当前是渲染能力，课堂真实候选接线仍未完成。
- 主代理执行demo state/AST隔离/同页扩展9条直接断言通过；这是轻量纯函数执行，不是完整unit/类型/PG验收。完整测试仍受其他发布构建持有的共享锁阻挡。

## 本轮实际验证更新（2026-10-24，后于上述记录）

- 纠正旧归因：当前安装React/react-dom为19.1.9，终端继承NODE_ENV=production导致React.act不存在；仅换test-utils导入不能解决。显式NODE_ENV=test后组件可正常执行，不修改依赖。
- 12文件94项初跑：88通过6失败。4项reader fixture选错MIME渲染分支，1项课堂focus应允许选区消失后回稳定root，1项共享机多步骤drawer超过局部5秒。修fixture/局部timeout，保留行为断言。
- 修后5文件71项通过（reader/lesson/drawer/客户端39项/上下文扩展16项），日志`/tmp/explore-stage1-final-recheck.log`。
- 原划词与选区3文件8项通过，日志`/tmp/explore-selection-regression.log`。
- 真实隔离原生PG8项全部通过（首次1项5秒超时，局部15秒后实际2.6秒通过），日志`/tmp/explore-preview-pg-final.log`。没有reset数据库。
- 阶段2A上下文审阅组件11项通过；真实assistant view/binding/intent 3文件45项通过。默认折叠，不增加首屏说明墙；请求payload与身份不改。
- 新增concept/demo/context-review/lesson-preview及DBhelper定向ESLint退出0，git diff --check通过。
- Web全类型检查**未通过验证**：继承512MB堆上限OOM；1GB重试运行超过40分钟无诊断后由主代理停止，不能当成功。新UI/数据分支仍需完整类型CI与用户浏览器验收。
- 自动概念AST渲染能力已通过10项测试，但没有用真实课程图谱为课堂自动注入候选；课堂当前为显式划词预览，只显示已经可见片段。持久分支、多引用、正式解释评分、节点整理尚未实现。
- 测试批次存在重叠，不把各批数字直接相加为总覆盖数。

## 历史审查清单（以下多项已修，以上方更新为准）

1. **实际价值**：当前preview locator只返回用户选中的同一短语。这个能证明选区，却不等于概念解释。最小可用预览至少要展示同页经过权限/版本校验的有限原文上下文（句子/段落，注明“材料原文”），并显示实际扩展范围；无相关上下文则明确只核对到词而非假释义。不得用模型偷补，不可跨页扩大到答案区。
2. **响应验证**：preview-client当前 `response.json() as ...` 未做边界schema。要加严格response schema与locator/content/state校验；error body友好解析，不把unknown状态交给UI。为reply身份错配与坏JSON加近测。
3. **交付ACK**：API当前返回exposureReceipts但client尚未ACK。客户端读回并通过schema/身份校验后沿用acknowledgeStudyExposure；失败不恢复独立资格。ACK是学习事实链不是可随意省掉的埋点。
4. **protected/open attempts限制**：首片helper拒绝workspace内任何open attempt，这是保守reader-only范围，不是完整闭卷策略。UI提示应说明“当前有进行中作答，请回原题入口”，不能让无关课程看起来资料坏了。后续课堂支持必须单独接权威attempt规则，不能删除全局阻断后放开。
5. **预览错配后的继续问**：继续问依赖原StudyContextTools服务器核验，restricted/stale不可继续，版本变动不默换。关闭/abort已生成曝光仍保持；不因为前端旧响应丢弃而清事实。
6. **界面文案**：正常用户不需要裸source UUID/offset作为主要出处。显示资料名、页码、版本；详细定位放可展开诊断，不改变响应中的机器locator。
7. **测试**：真实unit/route tests、数据库delivery与同key重试、manifest修订、max:1连接、权限/答案限制。发布占锁时排队，不绕开共享锁。集成使用STAGES.md明确隔离库，禁止reset。

8. **测试fixture类型**：concept-preview.test.tsx的available.contextAnchor目前缺必需purpose；最终Web/测试类型检查应一并修。服务/组件mock返回值不要编造不符合契约的locator范围而仅靠cast通过。
9. **失败边界**：request没有attempt/context时只支持reader，不能宣称课堂预览已完成。第一阶段还需按计划扩activity/turn授权来源或明确阶段1B剩余项；reader同词回显也不能当术语解释已完成。

10. **releaseKey边界**：request.clientKey允许120字符，但 `concept-preview:` + clientKey + `:` +64位fingerprint最长201字符，studyExposureReceiptSchema限制200。须减少clientKey最大长度或短前缀，并测边界，不能仅DB写入后返回不合法回执。

后端与前端当前各自独占文件；主代理在双方返回后分配修复，不并发覆盖。
