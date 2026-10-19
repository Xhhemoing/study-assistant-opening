import type { Sql, TransactionSql } from "postgres";
import {
  DEFAULT_OPENING_AI_SETTINGS, openingAdaptivePrefsSchema, openingAiSettingsSchema,
  plannedBlockSchema, systemQueryRequestSchema, systemQueryResultSchema,
  type Scope, type SystemQueryRequest, type SystemQueryResult,
} from "@aistudy/contracts";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { readSystemLearningQuery } from "./opening-system-query-learning";

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const literalSearch = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
export type SystemQueryPublicSettings = { process: "web" | "worker"; adaptivePlanning: boolean; teachingLoop: boolean };
export type SystemQueryReadOptions = { now?: () => Date; publicSettings?: () => SystemQueryPublicSettings };

/** Fixed SELECTs in a read-only snapshot. Scope comes from authenticated server code, never model arguments. */
export function createScopedOpeningSystemQueryReader(sql: Sql, scope: Scope, options: SystemQueryReadOptions = {}) {
  return async (raw: SystemQueryRequest, signal: AbortSignal): Promise<SystemQueryResult> => {
    const request = systemQueryRequestSchema.parse(raw);
    const now = options.now?.() ?? new Date();
    if (signal.aborted) throw new Error("system query cancelled");
    const result = await sql.begin("isolation level repeatable read read only", async tx => {
      await tx`SET LOCAL statement_timeout='2000ms'`;
      const [owner] = await tx`SELECT w.privacy_epoch,p.adaptive_planning,p.ai_settings,p.planning_settings,p.updated_at AS preferences_updated_at,
          COALESCE(r.revision,0) AS history_revision
        FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        LEFT JOIN opening_workspace_history_revisions r ON r.workspace_id=w.id AND r.owner_user_id=w.owner_user_id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      const out: SystemQueryResult = { name: request.name, status: "ok", reason: "read", asOf: now.toISOString(),
        version: `query-v1:epoch:${owner?.privacy_epoch ?? "unknown"}:history:${owner?.history_revision ?? "unknown"}`,
        data: [], evidence: [], sourceRefs: [], nextOffset: null };
      if (!owner) return { ...out, status: "unknown" as const, reason: "not_available" as const };
      const args = request.arguments;
      const limit = "limit" in args ? args.limit : 10, offset = "offset" in args ? args.offset : 0;
      const page = (rows: Row[]) => {
        if (rows.length > limit) { out.status = "partial"; out.reason = "truncated"; out.nextOffset = offset + limit; }
        return rows.slice(0, limit);
      };
      const evidence = (row: Row, kind: string, title: string, href: string, revision: string) => {
        out.evidence.push({ id: `${kind}:${row.id}`, kind, title: title.slice(0, 200), href, recordId: String(row.id), revision });
      };
      if (request.name === "courses") {
        const prefs = openingAdaptivePrefsSchema.safeParse(owner.adaptive_planning);
        const rows = await tx`SELECT id,title,updated_at FROM courses WHERE workspace_id=${scope.workspaceId} AND archived_at IS NULL
          AND ${request.arguments.query ? tx`title ILIKE ${literalSearch(request.arguments.query)}` : tx`TRUE`}
          ORDER BY title COLLATE "C",id LIMIT ${limit + 1} OFFSET ${offset}`;
        out.data = page(rows).map(row => {
          const storedGoal = prefs.success ? prefs.data.courseGoals[String(row.id)] ?? null : null;
          const goal = storedGoal ? { targetDate: storedGoal.targetDate, weeklyMinutes: storedGoal.weeklyMinutes,
            learningMode: storedGoal.learningMode ?? null, revision: storedGoal.revision ?? null } : null;
          evidence(row, "course", String(row.title), `/opening/courses/${row.id}`, iso(row.updated_at));
          return { id: row.id, title: String(row.title).slice(0, 240), updatedAt: iso(row.updated_at), goal,
            goalStatus: prefs.success ? goal ? "configured" : "not_configured" : owner.adaptive_planning == null ? "not_configured" : "invalid",
            summary: `${String(row.title).slice(0, 240)}${goal ? `；目标日期 ${goal.targetDate ?? "未设置"}，每周 ${goal.weeklyMinutes} 分钟` : "；未取得可确认的课程目标"}` };
        });
        if (owner.adaptive_planning != null && !prefs.success) { out.status = "partial"; out.reason = "unavailable"; }
      } else if (request.name === "learning" || request.name === "recommendation") {
        await readSystemLearningQuery(tx, scope, request, out, limit, offset);
      } else if (request.name === "materials") {
        if (!request.arguments.sourceId && !request.arguments.query?.trim()) return { ...out, status: "unknown" as const, reason: "invalid_arguments" as const };
        const a = request.arguments;
        if (a.sourceId) {
          const [source] = await tx`SELECT s.version,s.upload_state FROM opening_sources s WHERE s.workspace_id=${scope.workspaceId} AND s.id=${a.sourceId}
            AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
          if (!source || source.upload_state !== "uploaded") return { ...out, status: "unknown" as const, reason: "not_available" as const };
          if (a.sourceVersion !== undefined && Number(source.version) !== a.sourceVersion) return { ...out, status: "unknown" as const, reason: "stale" as const };
        }
        const rows = await tx`SELECT c.id,c.source_id,c.source_version,c.page,left(c.text,1200) AS excerpt,char_length(c.text) AS full_length,s.name
          FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id AND s.version=c.source_version
          WHERE s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded' AND s.parse_state='ready' AND length(btrim(c.text))>0
            AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.workspace_id=s.workspace_id AND v.source_id=s.id AND v.version=s.version AND v.availability='unavailable')
            AND ${a.sourceId ? tx`s.id=${a.sourceId}` : tx`TRUE`}
            AND ${a.sourceVersion !== undefined ? tx`c.source_version=${a.sourceVersion}` : tx`TRUE`}
            AND ${a.physicalPage ? tx`c.page=${a.physicalPage}` : tx`TRUE`}
            AND ${a.query?.trim() ? tx`c.text ILIKE ${literalSearch(a.query.trim())}` : tx`TRUE`}
          ORDER BY s.id,c.page NULLS LAST,c.id LIMIT ${limit + 1} OFFSET ${offset}`;
        out.data = page(rows).map(row => {
          const truncated = Number(row.full_length) > 1200;
          if (truncated) { out.status = "partial"; out.reason = "truncated"; }
          const sourceId = String(row.source_id), version = Number(row.source_version), physicalPage = row.page == null ? null : Number(row.page);
          out.sourceRefs.push({ sourceId, sourceVersion: version });
          out.evidence.push({ id: `chunk:${row.id}`, kind: "material", title: `${String(row.name).slice(0, 150)} · ${physicalPage ? `物理页 ${physicalPage}` : "页码未知"}`,
            href: `/opening/library?tab=materials&source=${sourceId}&version=${version}${physicalPage ? `&page=${physicalPage}` : ""}`,
            recordId: String(row.id), sourceId, sourceVersion: version, physicalPage });
          return { id: row.id, sourceId, sourceVersion: version, physicalPage, excerpt: row.excerpt, truncated, exposure: "not_assessed",
            summary: `${String(row.name).slice(0, 100)}，${physicalPage ? `物理页 ${physicalPage}` : "页码未知"}：${row.excerpt}${truncated ? "（节选，未覆盖完整内容）" : ""}` };
        });
      } else if (request.name === "jobs") {
        const a = request.arguments;
        const rows = await tx`SELECT * FROM (
          SELECT id,kind,state AS status,updated_at,'background' AS category FROM opening_jobs
            WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND ${a.jobId ? tx`id=${a.jobId}` : tx`TRUE`}
          UNION ALL SELECT j.id,'tutor' AS kind,j.status,j.updated_at,'tutor' AS category FROM opening_tutor_jobs j
            JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
            WHERE j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND ${a.jobId ? tx`j.id=${a.jobId}` : tx`TRUE`}
          ) jobs ORDER BY updated_at DESC,id LIMIT ${limit + 1} OFFSET ${offset}`;
        out.data = page(rows).map(row => {
          evidence(row, "job", `任务 ${row.id}`, "/opening/library", iso(row.updated_at));
          return { id: row.id, kind: row.kind, status: row.status, category: row.category, updatedAt: iso(row.updated_at),
            summary: `任务 ${row.id}（${row.kind}）：${row.status}；这是任务执行状态，不能证明内容质量或学习效果` };
        });
      } else if (request.name === "settings") {
        const parsed = openingAiSettingsSchema.safeParse(owner.ai_settings ?? DEFAULT_OPENING_AI_SETTINGS);
        if (!parsed.success) return { ...out, status: "unknown" as const, reason: "unavailable" as const };
        // Construct a whitelist. Never spread config, env, vault/provider rows or budget/security settings.
        const publicSettings = options.publicSettings?.();
        if (owner.preferences_updated_at) out.evidence.push({ id: `settings:${scope.workspaceId}`, kind: "settings", title: "已保存的模型设置",
          href: "/opening/settings", recordId: scope.workspaceId, revision: iso(owner.preferences_updated_at) });
        out.data = [{ mode: parsed.data.mode, defaultModelId: parsed.data.defaultModelId, manualModelId: parsed.data.manualModelId,
          routes: parsed.data.routes, taskRoutes: parsed.data.taskRoutes ?? {}, savedAt: owner.preferences_updated_at ? iso(owner.preferences_updated_at) : null,
          queryTools: systemQueryRequestSchema.options.map(option => option.shape.name.value), modelConnectivity: "not_checked", deployment: "not_checked",
          unavailableDomains: ["notes", "review_queue", "cost_summary", "historical_material_versions", "persisted_decisions"],
          ...(publicSettings ? { process: publicSettings.process, adaptivePlanning: publicSettings.adaptivePlanning, teachingLoop: publicSettings.teachingLoop } : {}),
          summary: `已保存的模型路由为${parsed.data.mode === "manual" ? "手动" : "自动"}模式${publicSettings ? `；当前 ${publicSettings.process} 进程：自适应规划${publicSettings.adaptivePlanning ? "开启" : "关闭"}，教学循环${publicSettings.teachingLoop ? "开启" : "关闭"}` : "；未核实运行进程的功能开关"}。未检测真实模型连通性或另一进程的配置` }];
        if (!publicSettings) { out.status = "partial"; out.reason = "not_available"; }
      } else if (request.name === "planning") {
        await readPlanning(tx, scope, request, owner, out, now, page, evidence);
      } else if (request.name === "teaching") {
        const a = request.arguments;
        const rows = await tx`SELECT a.id,a.status,a.generate_status,a.path_version,a.content_version,a.updated_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceId',s.id,'sourceVersion',s.version)) FROM opening_sources s
              WHERE s.workspace_id=a.workspace_id AND s.id=ANY(a.source_ids)),'[]'::jsonb) AS source_refs
          FROM opening_teaching_activities a JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id AND c.archived_at IS NULL
          WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${a.courseId}
            AND NOT EXISTS(SELECT 1 FROM unnest(a.source_ids) sid LEFT JOIN opening_sources s ON s.id=sid AND s.workspace_id=a.workspace_id
              WHERE s.id IS NULL OR s.upload_state<>'uploaded' OR EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=a.workspace_id AND e.source_id=sid)
                OR EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.workspace_id=a.workspace_id AND v.source_id=sid AND v.version=s.version AND v.availability='unavailable'))
          ORDER BY a.updated_at DESC,a.id LIMIT ${limit + 1} OFFSET ${offset}`;
        out.data = page(rows).map(row => {
          out.sourceRefs.push(...row.source_refs as SystemQueryResult["sourceRefs"]);
          evidence(row, "teaching_activity", `教学活动 ${row.id}`, `/opening/courses/${a.courseId}/study`, `path:${row.path_version}:content:${row.content_version}`);
          return { id: row.id, status: row.status, generateStatus: row.generate_status, pathVersion: Number(row.path_version), contentVersion: Number(row.content_version),
            updatedAt: iso(row.updated_at), summary: `教学活动 ${row.id}：${row.status}，生成状态 ${row.generate_status}；元数据不证明内容已独立复核、已完成学习或已掌握` };
        });
      }
      if (!out.data.length && out.status === "ok") { out.status = "unknown"; out.reason = "no_data"; }
      out.sourceRefs = [...new Map(out.sourceRefs.map(ref => [`${ref.sourceId}:${ref.sourceVersion}`, ref])).values()];
      if (out.sourceRefs.length > 64) return { ...out, status: "unknown" as const, reason: "truncated" as const, data: [], evidence: [], sourceRefs: [] };
      return out;
    });
    if (signal.aborted) throw new Error("system query cancelled");
    // A privacy change committed outside the snapshot invalidates every byte of the result.
    const [current] = await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!current || !result.version.includes(`:epoch:${current.privacy_epoch}:`)) throw new Error("system query privacy changed");
    return systemQueryResultSchema.parse(result);
  };
}

async function readPlanning(tx: TransactionSql, scope: Scope, request: Extract<SystemQueryRequest, { name: "planning" }>, owner: Row,
  out: SystemQueryResult, now: Date, page: (rows: Row[]) => Row[], evidence: (row: Row, kind: string, title: string, href: string, revision: string) => void) {
  const a = request.arguments, timeZone = resolveWorkspaceTimeZone((owner.planning_settings as { timeZone?: string } | null)?.timeZone);
  const date = a.date ?? localDateKeyInZone(now, timeZone);
  const [state] = await tx`SELECT accepted_version,accepted_blocks,updated_at FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${date}::date`;
  if (!state) { out.status = "unknown"; out.reason = "no_data"; return; }
  const parsed = plannedBlockSchema.array().max(200).safeParse(state.accepted_blocks);
  if (!parsed.success) { out.status = "unknown"; out.reason = "unavailable"; return; }
  out.version += `:plan:${state.accepted_version}`;
  const blocks = parsed.data.slice(a.offset, a.offset + a.limit + 1), ids = blocks.map(block => block.taskId);
  const tasks = ids.length ? await tx`SELECT id,title,status,minutes,origin,candidate_id,version FROM opening_tasks
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id=ANY(${ids}::uuid[])` : [];
  const byId = new Map(tasks.map(row => [String(row.id), row]));
  out.data = page(blocks as unknown as Row[]).map(raw => {
    const block = raw as unknown as typeof parsed.data[number], task = byId.get(block.taskId);
    // Derived titles/reasons need ancestry admission. Until that is connected, return only schedule metadata.
    const title = task?.origin === "manual" && task.candidate_id == null ? String(task.title).slice(0, 240) : "已确认学习任务";
    if (!task) { out.status = "partial"; out.reason = "stale"; }
    if (task) evidence(task, "task", title, "/opening/today", String(task.version));
    return { date, timeZone, acceptedVersion: Number(state.accepted_version), taskId: block.taskId, title, start: block.start, end: block.end,
      taskStatus: task?.status ?? "unavailable", summary: `${date} ${title}：${block.start} 至 ${block.end}，任务状态 ${task?.status ?? "不可确认"}；已确认计划版本 ${state.accepted_version}` };
  });
  if (!parsed.data.length) out.data = [{ date, timeZone, acceptedVersion: Number(state.accepted_version), summary: `${date} 已确认计划为空（版本 ${state.accepted_version}）` }];
}
