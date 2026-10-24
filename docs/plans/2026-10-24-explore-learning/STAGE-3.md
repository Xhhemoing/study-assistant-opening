# 阶段3预拆解：自己的理解与正式解释检查

执行前以本地最新tree重新核对。非评分先行，不能仅把listen结果写入opening_skill_evidence就当评分完成。

## 3A 非评分理解记录

现有SnippetCreateInput要求savedTurnId或provenanceId，且片段可用性主要服务assistant回答。因此不能把用户原话伪装成assistant snippet；也不应无来源地把AI feedback覆盖笔记。可复用editor文档/版本能力保存有结构的小记录，但来源需服务端由conversation/turn导出。

最小UI：明确'我来解释'→用户输入→显式发请求（listen上下文）→AI反馈→用户修订。前三份内容分别标user_original/assistant_feedback/user_revision，并有来源位置/会话链接。非评分状态不出现正确率/已掌握，不写observation、BKT、FSRS，不自动建卡。人工保存自己的原话无需模型，模型不可用也能先记录。

接入原则：先读 editor/createDocument/block schema与现有note provenance，找到其拥有者再实现；不新建第二套笔记库，不把三个字符串拼成不能归属的正文。若已有JSON元数据足够，使用当前版本语义与既有公开接口，避免空泛新表。

## 本地实现进度（2026-10-24）

P07a已接入StudyContextTools“我的理解”：用户原话冻结、可选修订、显式预填现有对话不发送、显式保存为用户笔记。AI反馈仍在原会话，不自动捕获/评分。草稿作用域绑定已验证账号/workspace；未知保存结果锁住重建；超长JSON编码输入完整留在当前面板供复制，不写坏草稿。普通笔记切换和notes受控入口已补回归。

实际主代理复跑：P07a的13条draft与6条UI测试通过；分支纯算法33项同时通过（合计本批52项），改动ESLint及git diff检查通过。分支纯算法另做独立strict TypeScript检查通过；完整Web类型仍待CI，不宣称全树通过。

P07b正式解释评分未实施；不写observation/BKT/FSRS，不把保存当掌握。用户浏览器验收待反馈。

## 3B 正式解释题

题目必须有稳定task identity、concept/node、source/version/manifestRevision、rubric version。评价core accuracy/necessary conditions/reasoning/examples，对应criteria中的correct/incorrect/unverified与反馈；模型不可信输入沿现有schema parse。

复用本地grade-observation与answerRevision/unknown_cost。材料答案refs/source refs和争议状态全部保留。改评生成新版本，不能覆写原答或旧评价。

## 维度消费者审计是退出门

- attempt-service当前retest固定transfer；exam source integration固定procedure。
- adaptive/snapshot-evidence当前按skillLabel/requirementKey，无explain分流。
- 仅在skill_evidence增加explain不阻止summary/BKT/auto-error-card从observation计入。

先让server task kind推导explain，客户端不能自主选择证据维度。所有未适配消费者不得消费解释题成绩；可暂保存/展示解释反馈而隔离于聚合，必须显式说明，不做假掌握提升。旧题行为保持不变，不大改全自适应引擎。

## 分工

一人负责contracts/task kind/DB与schema消费边界，一人做UI但等待契约，一人只读审查污染路径。因为material/ai-evaluation仍有并行dirty，开工先协调，禁止大文件覆盖。

## 验收

原话不覆盖；来源真实；短而正确与流畅但错分别处理；概念含义变更/参考答案争议暂不计分；看过答案后修订不独立；同skill不同dimension不串；unknown_cost不自动重发；backup restore后rubric/身份/原答/评价一致；真实模型评测须受控小样本与人工核验。
