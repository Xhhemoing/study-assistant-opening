import type { SystemQueryRequest, SystemQueryResult } from "@aistudy/contracts";
import { parseSystemQueryIntent, resolveSystemQueryDate, type SystemQueryClock, type SystemQueryFocus } from "./system-query-intent";

/** Semantic admission owns date/object selection; the planner cannot silently substitute either. */
export function createSystemQueryRoute(question: string, clock: SystemQueryClock, focus?: SystemQueryFocus) {
  const intent = parseSystemQueryIntent(question, clock, focus), normalized = question.normalize("NFKC").toLowerCase();
  const courseScoped = intent.kind === "learning" || intent.kind === "recommendation" || intent.kind === "teaching";
  let clarification = intent.blocked ? intent.clarification : undefined, courseId = focus?.courseId ?? undefined;
  const sourceIds = new Set(focus?.sourceId ? [focus.sourceId] : []);
  const explicitName = question.match(/[“「『"]([^”」』"]{1,240})[”」』"]/)?.[1];
  const contains = (text: string) => normalized.includes(text.normalize("NFKC").toLowerCase());
  const deny = (message: string): null => { clarification = message; return null; };
  return {
    clock,
    get clarification() { return clarification; },
    admit(request: SystemQueryRequest): SystemQueryRequest | null {
      if (request.name === "planning") {
        const date = resolveSystemQueryDate(question, clock);
        if (!date.date) return deny(date.clarification!);
        if (request.arguments.date !== undefined && request.arguments.date !== date.date) return deny("查询日期与问题不一致，请明确指定日期后重试。");
        return { ...request, arguments: { ...request.arguments, date: date.date } };
      }
      if (request.name === "courses") {
        const id = request.arguments.courseId;
        if (id && ((focus?.courseId && id !== focus.courseId) || (id !== courseId && !contains(id)))) return deny("课程筛选对象未由用户或完整候选确认，请先选择课程。");
        if (request.arguments.query && (!explicitName || request.arguments.query.normalize("NFKC").toLowerCase() !== explicitName.normalize("NFKC").toLowerCase())) return deny("请先选择课程，或用引号明确课程名称；不能由模型猜测或缩小课程对象。");
        if (focus?.courseId && !id) return { ...request, arguments: { ...request.arguments, courseId: focus.courseId } };
      }
      if ((request.name === "learning" || request.name === "recommendation" || request.name === "teaching")
        && ((focus?.courseId && request.arguments.courseId !== focus.courseId)
          || (request.arguments.courseId !== courseId && !contains(request.arguments.courseId)))) return deny("请先选择一门课程，或明确课程名称；当前不会替你猜选课程。");
      if (request.name === "materials") {
        if ((focus?.sourceIds?.length ?? 0) > 1) return deny("已选择多份材料，请先选择一份材料再定位。");
        if (focus?.sourceId) {
          if (request.arguments.sourceId !== undefined && request.arguments.sourceId !== focus.sourceId) return deny("材料对象与当前指定材料不一致，请重新选择材料。");
          if (focus.sourceVersion !== undefined && request.arguments.sourceVersion !== undefined && request.arguments.sourceVersion !== focus.sourceVersion) return deny("材料版本与当前指定版本不一致，请重新选择材料版本。");
          if (focus.physicalPage && request.arguments.physicalPage !== undefined && request.arguments.physicalPage !== focus.physicalPage) return deny("物理页与当前指定页不一致，请重新选择物理页。");
          return { ...request, arguments: { ...request.arguments, sourceId: focus.sourceId,
            ...(focus.sourceVersion === undefined ? {} : { sourceVersion: focus.sourceVersion }), ...(focus.physicalPage ? { physicalPage: focus.physicalPage } : {}) } };
        }
        if (request.arguments.sourceId) {
          if (!sourceIds.has(request.arguments.sourceId) && !contains(request.arguments.sourceId)) return deny("材料对象尚未唯一确认，请先选择一份材料。");
        } else if (!explicitName || request.arguments.query !== explicitName || request.arguments.physicalPage !== undefined || request.arguments.sourceVersion !== undefined) return deny("请用引号提供原文关键词；未选择材料时不能用模型指定的页码或版本缩小候选。");
      }
      return request;
    },
    observe(result: SystemQueryResult, request?: SystemQueryRequest) {
      if (!focus?.courseId && result.name === "courses" && result.status === "ok" && result.nextOffset === null
        && request?.name === "courses" && request.arguments.offset === 0) {
        const matches = result.data.filter(row => row.title.trim().length > 0 && contains(row.title));
        const filterId = request.arguments.courseId;
        if (filterId) {
          if (contains(filterId) && result.data.length === 1 && result.data[0]!.id === filterId) courseId = filterId;
        } else if (result.data.length === 1) courseId = result.data[0]!.id;
        else if (matches.length === 1) courseId = matches[0]!.id;
      }
      if (result.name === "materials" && result.data.length) {
        const complete = result.status === "ok" && result.nextOffset === null && request?.name === "materials" && request.arguments.offset === 0;
        if (!complete) { if (!focus?.sourceId) clarification = "材料候选尚未完整覆盖，请选择一份明确材料；不能凭截断或分页结果确认唯一来源。"; return; }
        const ids = [...new Set(result.sourceRefs.map(ref => ref.sourceId))];
        if (ids.length === 1) sourceIds.add(ids[0]!);
        else if (ids.length > 1) clarification = "关键词匹配多份材料，请选择一份材料后再定位；以下仅为候选记录。";
      }
    },
    fallback(): SystemQueryRequest[] {
      if (intent.clarification) { clarification = intent.clarification; return []; }
      if (intent.kind === "settings") return [{ name: "settings", arguments: {} }];
      if (intent.kind === "jobs") return [{ name: "jobs", arguments: { limit: 5, offset: 0 } }];
      if (intent.kind === "planning") return [{ name: "planning", arguments: { date: intent.date, limit: 5, offset: 0 } }];
      if (intent.kind === "materials") return [{ name: "materials", arguments: { ...(focus?.sourceId
        ? { sourceId: focus.sourceId, ...(focus.sourceVersion === undefined ? {} : { sourceVersion: focus.sourceVersion }), ...(focus.physicalPage ? { physicalPage: focus.physicalPage } : {}) }
        : { query: intent.query }), limit: 5, offset: 0 } }];
      if (courseScoped && courseId) return [this.nextCourse()!];
      return [{ name: "courses", arguments: { ...(focus?.courseId ? { courseId: focus.courseId } : {}), ...(intent.query ? { query: intent.query } : {}), limit: 5, offset: 0 } }];
    },
    nextCourse(): SystemQueryRequest | null {
      if (!courseScoped) return null;
      if (!courseId) return deny("无法唯一确认课程，请先选择一门课程或明确课程名称，再查询作答或教学记录。");
      return intent.kind === "recommendation" ? { name: "recommendation", arguments: { courseId } }
        : { name: intent.kind as "learning" | "teaching", arguments: { courseId, limit: 5, offset: 0 } };
    },
    finish() { if (courseScoped && !courseId) deny("无法唯一确认课程，请先选择一门课程或明确课程名称。"); },
  };
}
