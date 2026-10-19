import type { SystemQueryRequest } from "@aistudy/contracts";
export type SystemQueryClock = { today: string; timeZone: string };
export type SystemQueryFocus = { courseId?: string | null; sourceId?: string; sourceIds?: string[]; sourceVersion?: number; physicalPage?: number | null };
export type SystemQueryIntent = { kind: SystemQueryRequest["name"] | "unknown"; date?: string; query?: string; clarification?: string; blocked?: boolean };
const quoted = (text: string) => text.match(/[“「『"]([^”」』"]{1,240})[”」』"]/)?.[1];
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
export function resolveSystemQueryDate(question: string, clock: SystemQueryClock): { date?: string; clarification?: string } {
  const dates = [...question.matchAll(/\d{4}-\d{1,2}-\d{1,2}/g)].map(match => match[0]);
  const relative = [...question.matchAll(/大后天|后天|明天|明日|今天|今日|现在|昨天|昨日|前天|tomorrow|today|yesterday/gi)].map(match => match[0].toLowerCase());
  if (dates.length + relative.length !== 1 || /下周|本周|这周|周[一二三四五六日天]|星期|月底|月初|下个?月|next week|this week/i.test(question)) return { clarification: "请指定一个日期（YYYY-MM-DD），或说明今天、明天、后天、昨天；当前不支持日期范围或星期推算。" };
  if (dates.length) return validDate(dates[0]!) ? { date: dates[0] } : { clarification: "这个日期无效，请使用真实的 YYYY-MM-DD 日期。" };
  const offsets: Record<string, number> = { 大后天: 3, 后天: 2, 明天: 1, 明日: 1, 今天: 0, 今日: 0, 现在: 0, 昨天: -1, 昨日: -1, 前天: -2, tomorrow: 1, today: 0, yesterday: -1 };
  const date = new Date(`${clock.today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offsets[relative[0]!]!);
  return { date: date.toISOString().slice(0, 10) };
}

/** Finite deterministic intents. An unrecognized question never defaults to a different record. */
export function parseSystemQueryIntent(question: string, clock: SystemQueryClock, focus?: SystemQueryFocus): SystemQueryIntent {
  const original = question.normalize("NFKC").trim();
  // Quoted object names are data, e.g. “解析几何” is not a parser-status intent.
  const text = original.replace(/[“「『"]([^”」』"]+)[”」』"]/g, "");
  const scoped = (kind: "teaching" | "recommendation" | "learning"): SystemQueryIntent => !focus?.courseId
    && (/比较|对比|两门|两科|多门|所有课程|全部课程|分别|compare|both/i.test(text) || [...original.matchAll(/[“「『"]([^”」』"]+)[”」』"]/g)].length > 1)
    ? { kind, blocked: true, clarification: "涉及多门课程，请先选择一门课程；当前不支持跨课程汇总或比较学习资格。" }
    : { kind, query: quoted(original) };
  if (/设置|模型|开关|生效|settings|model/i.test(text)) return { kind: "settings" };
  if (/后台|(?:解析|导入|编译)(?:任务|进度|完成|成功|失败|了吗)|处理进度|\bjobs?\b|worker/i.test(text)) return { kind: "jobs" };
  if (/哪.{0,1}页|原文|材料|文件|文档|讲义|source|page/i.test(text)) {
    if ((focus?.sourceIds?.length ?? 0) > 1) return { kind: "materials", blocked: true, clarification: "已选择多份材料，请先选择一份材料再定位物理页；当前不会替你猜选。" };
    if (!focus?.sourceId && !quoted(original)) return { kind: "materials", blocked: true, clarification: "请先选择一份材料，或用引号提供要定位的原文关键词。" };
    return { kind: "materials", query: quoted(original) };
  }
  if (/计划|日程|安排|schedule|plan/i.test(text)) { const date = resolveSystemQueryDate(original, clock); return { kind: "planning", ...date, blocked: Boolean(date.clarification) }; }
  if (/任务|待办|task|to.?do/i.test(text)) return { kind: "unknown", blocked: true, clarification: "你想查询后台任务状态，还是某天已确认的学习计划？请说明类型；当前不支持全部学习待办汇总。" };
  if (/课程列表|哪些课|有哪些课|课程.*有哪些|课程目标|学习目标|courses|goal/i.test(text)) return { kind: "courses" };
  if (/教学|自学|串讲|拔高|teach/i.test(text)) return scoped("teaching");
  if (/为何|为什么|推荐|建议|why|recommend/i.test(text)) return scoped("recommendation");
  if (/学到|学得|学习情况|进度|进展|练习|答题|作答|核验|学习记录|掌握|错题|成绩|learning|progress/i.test(text)) return scoped("learning");
  return { kind: "unknown", clarification: "请说明要查询的系统记录：课程/目标、作答核验、教学活动、指定材料页码、指定日期的已确认计划、后台任务或模型设置。" };
}
