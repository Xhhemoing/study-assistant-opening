import { recordTopics, isRecordFollowup, type RecordQuestionContext, type RecordTopic, type SystemQueryRequest, type SystemQueryResult } from "@aistudy/contracts";

export type SystemQueryFocus = { courseId?: string | null; sourceId?: string; sourceIds?: string[]; sourceVersion?: number; physicalPage?: number | null; date?: string };
export type QuerySelection = { topics: RecordTopic[]; courseQuery?: string; courseText?: string; date?: string; dateExplicit: boolean; invalidDate: boolean; ambiguousCourse: boolean };
const normalize = (text: string) => text.toLowerCase().replace(/高数/g, "高等数学").replace(/\s|[《》“”"']/g, "");
function courseText(text: string): string | undefined {
  const quoted = text.match(/[《“"]([^》”"]{1,80})[》”"]/u)?.[1];
  if (quoted) return quoted;
  // Named common aliases are referents, never an assumption about what is enrolled.
  const named = text.match(/高等数学[一二三上下ABⅠⅡ123]?|高数[一二三上下ABⅠⅡ123]?|线性代数|概率论(?:与数理统计)?|大学物理|英语|微积分|[A-Za-z0-9一二三四五六七八九十]+课/iu)?.[0];
  if (named) return named.split(/进度|练习|作答|测验|任务|课程|课|学到哪|状态|情况/u)[0];
  if (/课程列表|哪些课/.test(text)) return undefined;
  const changed = text.match(/^(?:那么|那|what about\s+)(.+?)(?:呢|怎么样|[？?])?$/iu)?.[1];
  if (changed && !recordTopics(changed).length && !/今天|明天|后天|昨天|前天|刷新|继续|还有|多少|完成|核验|变化|现在|然后|这门|它|其|怎么样|记录|状态/.test(changed)) return changed.replace(/[？?]$/, "");
  text = text.replace(/(?:解析|导入|编译)(?:任务|进度|完成|成功|失败|了吗)|后台(?:处理|任务)?|处理进度/g, "");
  const before = text.match(/(?:查(?:询)?(?:一下)?|看看|关于|那|我的|我|请问|当前)?([^，。？?；、\s]{1,60}?)(?:课程的?|课的|的?(?:学习进度|进度|练习情况|作答情况|测验情况)|的(?:练习|作答|测验|学习状态|任务))/u)?.[1];
  if (!before || /^(我|我的|的|本门|这门课|当前课程|现在的|当前的|现在|当前|今天|明天|昨天|已有|已保存|这门|这|那|它|其|学习|练习|作答|任务|计划|记录|系统)$/.test(before)) return undefined;
  return before.replace(/^(?:请|帮我|查询一下|查询|查一下|查|看看|我的|我|关于|那么|那)/u, "") || undefined;
}
export function selectSystemQuery(question: string, previousQuestion: RecordQuestionContext | undefined, today: string): QuerySelection {
  let previous: QuerySelection | undefined;
  const questions = typeof previousQuestion === "string" ? [previousQuestion] : previousQuestion ?? [];
  for (const part of questions.slice(-8)) previous = selectQuestion(part, isRecordFollowup(part) ? previous : undefined, today);
  return selectQuestion(question, isRecordFollowup(question) ? previous : undefined, today);
}
/** Replay referents in order so a workspace-topic reset survives later refreshes. */
function selectQuestion(question: string, previous: QuerySelection | undefined, today: string): QuerySelection {
  const ownTopics = recordTopics(question), topics = ownTopics.length ? ownTopics : previous?.topics ?? [];
  if (/任务/.test(question) && topics.some(topic => topic === "learner_state" || topic === "learning") && !topics.includes("planning")) topics.push("planning");
  const quotedCourses = [...question.matchAll(/[《“"]([^》”"]{1,80})[》”"]/gu)].map(match => normalize(match[1]!));
  const namedCourses = [...question.matchAll(/高等数学[一二三上下ABⅠⅡ123]?|高数[一二三上下ABⅠⅡ123]?|线性代数|概率论(?:与数理统计)?|大学物理|英语|微积分/giu)].map(match => normalize(match[0]));
  const workspaceTopic = ownTopics.some(topic => ["courses", "settings", "notes", "jobs", "exam_sprint"].includes(topic));
  const ownCourse = courseText(question), course = ownCourse ?? (workspaceTopic ? undefined : previous?.courseText);
  const ambiguousCourse = new Set(quotedCourses.length ? quotedCourses : namedCourses).size > 1 || !ownCourse && !workspaceTopic && !!previous?.ambiguousCourse;
  // A named course is an object referent, even when its title contains Next.js,
  // 明天 or an ISO date. Only text outside that referent constrains the query date.
  const dateText = (ownCourse ? question.replace(ownCourse, "") : question)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "");
  const datePattern = /今天|今日|明天|明日|后天|昨天|昨日|前天|\d{4}-|\b(?:tomorrow|today|yesterday)\b/i;
  const unsupportedPattern = /大后天|大前天|后日|次日|隔天|月底|月初|上周|下周|本周|这周|每周|最近|过去|未来|明年|去年|下月|本月|这月|上月|周[一二三四五六日天]|星期|礼拜|\d+\s*(?:天|日|周|个月|月|年)(?:前|后|内)|[一二三四五六七八九十]+月|[一二三四五六七八九十]+[号日]|\d{1,2}月\d{1,2}日|\b(?:weeks?|months?|last|next|between)\b|\bfrom\b.*\bto\b|[至到].*\d{4}-/i;
  const otherDatePattern = /\d{1,4}[/.]\d{1,2}(?:[/.]\d{1,2})?|今晚|明晚|昨晚|今早|明早|\d{1,2}(?:号|日)|\d{1,2}月份?|(?:19|20)\d{6}/;
  const hasDate = datePattern.test(dateText) || unsupportedPattern.test(dateText) || otherDatePattern.test(dateText);
  const isoTokens = [...dateText.matchAll(/\b\d{4}-[A-Za-z0-9_-]*/g)].map(match => match[0]);
  const absolute = isoTokens.filter(token => /^\d{4}-\d{2}-\d{2}$/.test(token));
  const relative = [...dateText.matchAll(/今天|今日|明天|明日|后天|昨天|昨日|前天|\b(?:today|tomorrow|yesterday)\b/gi)].map(match => match[0].toLowerCase());
  const offsets: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 昨天: -1, 昨日: -1, 前天: -2, today: 0, tomorrow: 1, yesterday: -1 };
  const dates = [...absolute, ...relative.map(day => new Date(Date.parse(`${today}T00:00:00Z`) + offsets[day]! * 86400000).toISOString().slice(0, 10))];
  const malformedDate = isoTokens.length !== absolute.length || /\d{4}-/.test(dateText) && !isoTokens.length || otherDatePattern.test(dateText);
  const invalidDate = hasDate ? unsupportedPattern.test(dateText) || malformedDate || new Set(dates).size > 1
    || dates.some(date => !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    : !workspaceTopic && !!previous?.invalidDate;
  return { topics, courseText: course, courseQuery: course ? /^高数|^高等数学/.test(course) ? "高" : course : undefined,
    date: hasDate ? dates[0] : (!workspaceTopic ? previous?.date : undefined) ?? (topics.includes("planning") ? today : undefined),
    dateExplicit: hasDate || !workspaceTopic && !!previous?.dateExplicit, invalidDate, ambiguousCourse };
}
export function matchingCourses(result: SystemQueryResult, requested?: string) {
  if (result.name !== "courses" || result.status !== "ok" || result.nextOffset !== null) return [];
  return result.data.filter(row => !requested || normalize(row.title).includes(normalize(requested)));
}
/** Applied after schema validation and before every real read, including native calls. */
export function queryWithinFocus(request: SystemQueryRequest, focus: SystemQueryFocus, selection: QuerySelection): boolean {
  if (selection.topics.length && !selection.topics.includes(request.name as RecordTopic)) return false;
  if (request.name === "planning") return !selection.invalidDate && request.arguments.date === focus.date && request.arguments.courseId === (focus.courseId ?? undefined);
  if (selection.invalidDate || selection.dateExplicit && request.name !== "courses") return false; // Other tools expose current records, not historical snapshots.
  if (request.name === "courses" && !focus.courseId && !selection.courseText) return !request.arguments.courseId;
  if (["learning", "learner_state", "cards", "teaching", "recommendation", "courses"].includes(request.name)) {
    return "courseId" in request.arguments && !!focus.courseId && request.arguments.courseId === focus.courseId;
  }
  if (selection.courseText && ["notes", "exam_sprint", "jobs", "settings"].includes(request.name)) return false; // These readers have no course filter.
  if (request.name === "materials" && request.arguments.courseId !== (focus.courseId ?? undefined)) return false;
  if (request.name === "materials" && focus.sourceId) return request.arguments.sourceId === focus.sourceId && request.arguments.sourceVersion === focus.sourceVersion && request.arguments.physicalPage === (focus.physicalPage ?? undefined);
  return true;
}
