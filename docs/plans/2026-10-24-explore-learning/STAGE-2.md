# 阶段2预拆解：上下文与持久支线

执行前提：阶段1实际UI/preview契约已稳定并验收。不是立即派发，不与1A共享文件并写。

## 2A 上下文预览（无多引用写入）

沿现有AssistantView/Composer，把当前固定课程/attempt/资料version与用户携入fragment展示为不同区域。fragment来自界面，不称权威依据。用户可移除可选fragment但不可清除绑定身份/曝光。引用显示仅取真实response citations。范围保持单片段，不先改provider协议。补恢复、临时历史、不用资料≠无历史等行为测试。

## 2B 多引用持久化契约

先读 contracts/tutor/context，确定quote refs进入turn intent与source provenance的同一所有者。引用至少 origin/source或savedTurn、版本/locator；不能仅拼text。客户端只能提请，服务端重新核验和提取。来源撤回后相关派生历史应沿现有保守失效规则，不能仅删引用保留答案。

避免共享改动：contracts/schema/export父或指定一人；service/handler；UI separate，严格等契约完成再并行。

## 2C 分支数据与历史

### 已知现状
opening_conversations仅id/workspace/owner/title/course/timestamps。opening_turns带context_anchor/attempt/source_versions/context_source_refs。
loadTutorHistoryContext从current.user向同会话tutor_jobs读取已完成问答，排除query receipts，model/record_referents分开；20组候选、12000字符，并按来源/隐私epoch过滤。

### 必须明确的contract

- branch child唯一、parent与forkTurn同owner/workspace；branch origin必须来自已完整assistant/user exchange。
- relation=deepen/rephrase/related；contextPolicyVersion在服务器固定，不接受任意策略。
- 主入口仅保留/另开，创建零模型；clientKey幂等在同owner/parent范围，用existing事务模式。
- 返还childConversationId与合法returnAnchor；不需要客户端提供背景全文。
- 父不会因子创建改变course或turn；题目子分支不得换attempt/版本。
- 对上下文冻结：已complete的turn若不提供编辑API，可持久引用既有IDs；对隐私清除/来源禁用仍失效。不要为了“冻结”绕过清除保存正文快照。
- ordering需明确当前created_at+id相等时间问题，选择父exchange的有效边界，而非直接 `<= fork timestamp` 导致包括同时间未来消息。
- ancestry展开必须在总限额内；model不得包含旧系统查询，record_referents不得继承助手的状态断言。

### 备份测试
现有OPENING_BACKUP_TABLES、record-table-queries、restore columns/JSON、empty namespace、lineage privacy均要处理。旧包缺branch信息恢复成无parent的已有会话语义，不擅自编造关系；新包遇不支持关系的旧客户端应拒绝或明确兼容，不偷偷丢关系后继续模型调用。

### 删除/隐私
不能以 `ON DELETE CASCADE` 父关系顺带删掉子会话。parent被删除后child自身消息保留（按现有删除授权），关系变失效；继承内容不继续送模型。来源被遗忘时所有相关派生上下文按现有规则排除。源/turn ID本身也不向无权用户泄露。

### 数据库与发布
迁移号开工时重新看末号，不预占0098。本地集成DB串行，非生产。new writes gated until schema/backup ready；关入口不删除历史。需要扩contracts/public索引/backup由同一集成人负责。

## 2D UI与返回

等2C可读写/近测后才接message actions、路径和branch列表。选择任意完成回答“讲深一点/另开相关问题”；换种讲法默认同会话，不无谓建支线。context身份恢复用现有AssistantSession。根/child切换能恢复draft；临时对话明确不能假存。窄屏列表/面包屑不做canvas。保留原题，不自动完成/排程。

## 阶段2验收

同key并发、断网未知、撤权、父后续追加、兄弟历史隔离、相同时间排序、query receipt隔离、所有mode总预算、题目帮助跨branch、临时不存、备份restore、原路返回与草稿。

需要SQLite/浏览器模拟以外的原生PG事务实测。只通过UI mock不算阶段完成。
