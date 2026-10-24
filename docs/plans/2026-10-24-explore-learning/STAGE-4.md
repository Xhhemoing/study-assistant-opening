# 阶段4预拆解：节点个人整理与局部路径

## 4A 独立用户偏好

新增偏好小表，而非修改knowledgeNode.status枚举。字段以owner/workspace/course/node为唯一身份、decision accepted/dismissed、displayLabel可空、version与updatedAt。明确采纳不等于材料supported、不等于学生mastery。

读取：现有knowledge snapshot + 个人偏好投影。修改：版本检查CAS，用户可恢复默认。改名只改显示，原label仍作知识身份；不能影响已有skill mapping、评分或retest。隐藏只影响默认导航，不静默删除教学依赖。

稳定性：本地retainKnowledgeIdentities已支持唯一定义/identity保留。偏好nodeId加入referencedNodeIds与expectedReferencedNodeIds并发检查，重建过程中偏好新增须冲突重读，不丢用户选择。不能凭别名/同名附会到新概念；消失节点保留偏好但明确旧节点不可用，用户决定重新关联。

- 稳定identity且definition未变才沿用review overlay；偏好应保存basis version/定义依据，图谱语义变化后用户旧确认不自动移植。用户'隐藏'要持久但仅抑制相同身份的默认展示，不能跨新语义误隐藏。

proposals现为六类判别联合，不是通用CRUD。首版用户显式偏好更新无需让AI代确认；后续批量AI建议独立扩受控proposal类型。

## 4B 局部路径

仅使用阶段2真实branch数据，不能从聊天标题猜关系。路径=父→当前→直接子节点；独立显示'返回原题/原文'，不与知识先修关系混合。桌面列表/窄栏、移动折叠面包屑，不引入canvas图形库。

支线收束：关闭即返回；用户可选写一句收获或保存一个开放问题；不强制写总结、不自动合并旁支全部历史。关联笔记沿既有来源与revision，用户原话和AI总结区分。

## 验收

并发偏好写、重建保留、别名不污染ID、跨owner拒绝、隐藏恢复、missing节点提示、完整backup roundtrip；树的父/子/返回实际可达，资料被删不造死链接，关闭保留草稿，省略总结不阻塞主任务。

上线先开用户整理与局部路径，不自动给所有概念标注/建任务/增加复习队列。无样本指标保持not_collected。
