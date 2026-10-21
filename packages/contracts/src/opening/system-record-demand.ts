/** Conservative read demand, shared by saved/ephemeral server entry points.
 * History supplies only the user's referent; assistant prose is never evidence. */
export type RecordTopic = "learning" | "learner_state" | "planning" | "courses" | "cards" | "notes" | "jobs" | "settings" | "teaching" | "recommendation" | "materials" | "exam_sprint";
export type QueryHistory = readonly { role: string; text: string }[];
/** A string is one question; arrays preserve actual turn boundaries. */
export type RecordQuestionContext = string | readonly string[];
export function recordTopics(text: string): RecordTopic[] {
  const topics = new Set<RecordTopic>();
  const jobPattern = /(?:后台(?:处理|任务)?|(?:解析|导入|编译)(?:任务|进度|完成|成功|失败|了吗)|处理进度|\bjobs?\b|\bworkers?\b)/gi;
  const jobDemand = jobPattern.test(text);
  const learningText = text.replace(jobPattern, "");
  if (/进度|学到哪|学习状态|学习情况|\blearner[ _-]?state\b|\bprogress\b/i.test(learningText)) topics.add("learner_state");
  if (/练习|作答|测验|学习记录|测试记录|核验|答对|做了几|掌握|\battempts?\b|\bquiz(?:zes)?\b/i.test(text)) topics.add("learning");
  if (/计划|安排|日程|当前任务|学习任务|今天.*任务|明天.*任务|任务.*(有哪些|是什么|完成)|\bplans?\b|\bschedules?\b/i.test(learningText)) topics.add("planning");
  if (/课程列表|哪些课|课程目标|\bcourses\b|\bgoals?\b/i.test(text)) topics.add("courses");
  if (/卡片|复习队列|\bcards?\b|\breview queue\b/i.test(text)) topics.add("cards");
  if (/笔记|\bnotes?\b/i.test(text)) topics.add("notes");
  if (jobDemand || /任务.*(成功|失败)/.test(text)) topics.add("jobs");
  if (/设置|模型.*(生效|配置|路由)|\bsettings\b/i.test(text)) topics.add("settings");
  if (/教学活动|自学记录|串讲记录|\bteaching\b/i.test(text)) topics.add("teaching");
  if (/为什么.*推荐|为何.*建议|推荐依据|why.*recommend/i.test(text)) topics.add("recommendation");
  if (/原文在哪|哪一?页|材料记录/i.test(text)) topics.add("materials");
  if (/冲刺记录|\bsprints?\b/i.test(text)) topics.add("exam_sprint");
  return [...topics];
}
function isExplanationRequest(text: string): boolean {
  if (/\b(?:what (?:is|are)|explain|define|how (?:to|do|does|can))\b/i.test(text)
    && !/\b(?:my|our|saved|current|today|tomorrow|yesterday)\b/i.test(text)) return true;
  return /怎么(?:学|做|解|算|安排|制定)|如何(?:学|做|解|算|安排|制定)|证明|求导|求积分|讲解|出一道|来一道|这道题|想练习/.test(text)
    || /导数|积分|级数|函数|矩阵|方程|定理|公式|极限|收敛|定义|\bsin\b|\bcos\b/i.test(text) && /为什么|为何|是什么|怎么|如何|公式|定义/.test(text) && !/进度|情况|状态|记录|掌握/.test(text);
}
export function isRecordFollowup(text: string): boolean {
  if (isExplanationRequest(text)) return false;
  return /^(?:那|那么|为什么呢|为何呢|还剩|还有(?:呢|多少|几|哪些任务)|现在怎么样|现在呢|然后呢|继续查|再查|刷新|更新一下|还有呢|另一门|这门|它|其|明天呢|后天呢|昨天呢|今天呢|怎么样了|完成了吗|核验了吗|有变化吗|what about|and |refresh)/i.test(text.trim()) && text.length <= 240;
}
export function previousRecordQuestion(history: QueryHistory = []): string[] | undefined {
  const users = history.filter(row => row.role === "user").slice(-8);
  // Follow a chain of short continuations only; a different topic ends the chain.
  const parts: string[] = [];
  let standalone: string[] | undefined;
  for (let i = users.length - 1; i >= 0; i--) {
    const text = users[i]!.text;
    if (text.length > 2000 || excludesRecordRead(text)) return standalone;
    if (!isRecordFollowup(text)) return hasRecordReadDemand(text) ? [text, ...parts] : standalone;
    if (recordTopics(text).length && hasRecordReadDemand(text)) standalone = [text, ...parts];
    parts.unshift(text);
  }
  return standalone;
}
function excludesRecordRead(text: string): boolean {
  // Explicit mutation requests stay on the ordinary/draft path. This never grants write tools.
  return /(?:帮我|替我|请|直接|自动)?(?:删除|修改|更新计划|创建|新建|安排一下|接受|提交|标记.*完成|扩权|授权|获取权限)|\b(delete|create|update|submit|grant)\b/i.test(text)
    || isExplanationRequest(text);
}
export function hasRecordReadDemand(text: string, history: QueryHistory = []): boolean {
  if (excludesRecordRead(text)) return false;
  const topics = recordTopics(text);
  const asksForRecords = /记录|进度|情况|状态|学到哪|核验|[吗么？?]|怎么样|如何了|哪些|多少|几次|几道|查询|查一下|看看|当前任务|课程列表|生效|\b(?:my|our|current|saved|progress|show|list|check|find|read)\b/i.test(text)
    || /^我的(?:笔记|卡片|设置|复习队列)(?:呢)?$/.test(text.trim())
    || /^(?:我的?|当前|现在|今天|今日|明天|明日|后天|昨天|昨日|前天|的|学习|已确认)*(?:计划|安排|日程|任务|作答|练习)(?:呢|是什么|有哪些)?$/.test(text.trim());
  if (topics.length && asksForRecords) return true;
  return isRecordFollowup(text) && !!previousRecordQuestion(history);
}
