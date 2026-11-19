import {
  ASSET_GRAPH_DEFAULT_LIMIT,
  ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS,
  ASSET_GRAPH_LENS_RELATIONS,
  DEFAULT_OPENING_ADAPTIVE_PREFS,
  assetGraphPageSchema,
  assetGraphQuerySchema,
  formatAssetGraphNodeId,
  knowledgeSnapshotSchema,
  openingAdaptivePrefsSchema,
  parseAssetGraphNodeId,
  scopeSchema,
  type AssetGraphAction,
  type AssetGraphEdge,
  type AssetGraphLearnerState,
  type AssetGraphNode,
  type AssetGraphPage,
  type AssetGraphQuery,
  type AssetGraphRelation,
  type AssetGraphRequirementStatus,
  type AssetGraphRootKind,
  type AssetGraphSharedAttribution,
  type AssetGraphStateSummary,
  type CourseRequirement,
  type KnowledgeSnapshot,
  type LearningGoal,
  type LearningGoalList,
  type Scope,
} from "@aistudy/contracts";
import { courseRequirementProgress, learnerEvidenceDisplayState } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import {
  ASSET_GRAPH_NOT_FOUND_MESSAGE,
  OpeningAssetGraphError,
  computeAssetGraphQueryDigest,
  decodeAssetGraphCursor,
  encodeAssetGraphCursor,
  hashAssetGraphScopeFingerprint,
  resolveCursorSecret,
  type OpeningAssetGraphErrorCode,
} from "./opening-asset-graph-cursor";
import type { ExamCourseRouteObservation } from "./opening-course-exam-evidence-projection";
import {
  mapCourseRequirement,
  readCourseRouteMaterials,
  readCourseRouteObservations,
  readCourseRouteSourceChunks,
} from "./opening-course-route-read";
import { readSharedCourseEvidence } from "./opening-course-shared-skill-projection";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { projectOpeningAdaptiveGoals } from "./opening-learning-goal-bridge";
import { readLearningGoals } from "./opening-learning-goals";
import { openingNoteReadable } from "./opening-note-provenance";

export { OpeningAssetGraphError, type OpeningAssetGraphErrorCode };

export type OpeningAssetGraphOptions = {
  cursorSecret?: string | Uint8Array;
  now?: () => Date;
};

export type OpeningAssetGraphRepository = {
  query(scope: Scope, rawQuery: AssetGraphQuery): Promise<AssetGraphPage>;
};

type Db = TransactionSql;

type CourseRecord = {
  id: string;
  title: string;
  updatedAt: string | null;
};

type SourceRecord = {
  id: string;
  name: string;
  version: number;
  uploadState: string;
  parseState: string;
  aiExcluded: boolean;
  updatedAt: string | null;
};

type DocumentRecord = {
  id: string;
  title: string;
  lifecycle: string;
  currentRevisionNumber: number;
  updatedAt: string | null;
};

type ExplorationRecord = {
  id: string;
  title: string;
  status: string;
  courseId: string | null;
  goalId: string | null;
  updatedAt: string | null;
};

type MembershipRecord = {
  id: string;
  courseId: string;
  assetType: string;
  assetId: string;
  updatedAt: string | null;
};

type AssetLinkRecord = {
  id: string;
  assetType: "source" | "document";
  assetId: string;
  courseId: string | null;
  goalId: string | null;
  requirementId: string | null;
  revision: number;
  updatedAt: string | null;
};

type PromotionRecord = {
  id: string;
  explorationId: string;
  targetId: string;
  reviewedAt: string | null;
  updatedAt: string | null;
};

type ObservationHeaderRecord = {
  id: string;
  courseId: string;
  rootId: string;
  historyRevision: number;
  workspaceHistoryRevision: number;
  occurredAt: string | null;
  submittedAt: string | null;
  recordedAt: string | null;
  requirementKey: string | null;
  evalReqId: string | null;
};

type LoadedCourseObservations = {
  filteredRaw: Awaited<ReturnType<typeof readCourseRouteObservations>>["raw"];
  filteredProjected: ExamCourseRouteObservation[];
};

type SharedSkillLinkRecord = {
  id: string;
  revision: number;
  stableSkillId: string;
  sourceRequirementId: string;
  sourceRequirementRevision: number;
  targetRequirementId: string;
  targetRequirementRevision: number;
  updatedAt: string | null;
  sourceCourseId: string;
  sourceRequirementTitle: string;
  targetCourseId: string;
};

const REQUIREMENT_STATUS_LABELS: Record<AssetGraphRequirementStatus, string> = {
  unobserved: "待开始",
  needs_correction: "需要纠偏",
  assisted: "受助完成，待独立验证",
  needs_verification: "待验证",
  verified: "已有验证记录",
  blocked: "暂时受阻",
};

const LEARNER_STATE_LABELS: Record<AssetGraphLearnerState, string> = {
  independent: "独立完成",
  hinted: "依赖提示",
  retest: "待复测",
  insufficient: "证据不足",
};

const GOAL_LIFECYCLE_LABELS: Record<LearningGoal["lifecycle"], string> = {
  active: "进行中",
  maintenance: "定期维护",
  reduced: "减负推进",
  paused: "已暂停",
  stopped: "已停止",
  archived: "已归档",
};

const KNOWLEDGE_STATUS_LABELS: Record<"suggested" | "supported" | "needs_check", string> = {
  suggested: "待确认",
  supported: "已有材料支持",
  needs_check: "待核对",
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 300) : fallback;
}

function observationLabel(assistance: string): string {
  if (assistance === "independent") return "独立作答记录";
  if (assistance === "hinted") return "提示后作答记录";
  if (assistance === "revealed") return "查看解析后作答记录";
  return "作答记录";
}

function resolveAssetLinkTargetNodeId(link: AssetLinkRecord): string | null {
  if (link.requirementId) return formatAssetGraphNodeId({ kind: "requirement", uuid: link.requirementId });
  if (link.goalId) return formatAssetGraphNodeId({ kind: "goal", uuid: link.goalId });
  if (link.courseId) return formatAssetGraphNodeId({ kind: "course", uuid: link.courseId });
  return null;
}

function matchesRequirementIdentity(
  obs: Pick<ExamCourseRouteObservation, "courseRequirement" | "requirementKey">,
  req: CourseRequirement,
): boolean {
  return (
    obs.courseRequirement !== undefined &&
    obs.courseRequirement.id === req.id &&
    obs.courseRequirement.revision === req.revision &&
    obs.courseRequirement.stableSkillId === req.stableSkillId &&
    obs.courseRequirement.requirementKey === req.requirementKey &&
    obs.requirementKey === req.requirementKey
  );
}

function collectSourceIdsFromValue(value: unknown, into: Set<string>): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) into.add(item);
    }
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.length > 0) into.add(key);
    }
  }
}

/** Build a bounded, read-only projection repository over the workspace learning asset graph. */
export function createOpeningAssetGraphRepository(
  sql: Sql,
  options: OpeningAssetGraphOptions = {},
): OpeningAssetGraphRepository {
  return {
    async query(scope: Scope, rawQuery: AssetGraphQuery): Promise<AssetGraphPage> {
      const parsedScope = scopeSchema.safeParse({
        workspaceId: scope?.workspaceId,
        ownerUserId: scope?.ownerUserId,
      });
      if (!parsedScope.success) {
        throw new OpeningAssetGraphError("VALIDATION", "工作区作用域参数无效。");
      }
      const validScope = parsedScope.data;

      const parsedQuery = assetGraphQuerySchema.safeParse(rawQuery);
      if (!parsedQuery.success) {
        throw new OpeningAssetGraphError(
          "VALIDATION",
          parsedQuery.error.issues[0]?.message ?? "资产图查询参数无效。",
        );
      }
      const query = parsedQuery.data;
      const secret = resolveCursorSecret(options.cursorSecret);
      const queryDigest = computeAssetGraphQueryDigest(query);

      return sql.begin("isolation level repeatable read read only", async (tx: Db) => {
        await tx`SET LOCAL statement_timeout='2000ms'`;

        const [workspace] = await tx`
          SELECT transaction_timestamp() AS snapshot_as_of, w.privacy_epoch, p.adaptive_planning
          FROM workspaces w
          LEFT JOIN workspace_preferences p ON p.workspace_id = w.id
          WHERE w.id = ${validScope.workspaceId} AND w.owner_user_id = ${validScope.ownerUserId}
        `;
        if (!workspace) {
          throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
        }
        const asOf =
          toIso(workspace.snapshot_as_of) ?? (options.now?.() ?? new Date()).toISOString();
        const privacyEpoch = Number(workspace.privacy_epoch ?? 0);

        const warningSet = new Set<string>();
        let completeness: "complete" | "partial" = "complete";

        const courseRows = await tx`
          SELECT id, title, updated_at
          FROM courses
          WHERE workspace_id = ${validScope.workspaceId} AND archived_at IS NULL
          ORDER BY id
        `;
        const activeCourses = new Map<string, CourseRecord>();
        for (const row of courseRows) {
          const id = String(row.id);
          activeCourses.set(id, {
            id,
            title: normalizeLabel(row.title, "未命名课程"),
            updatedAt: toIso(row.updated_at),
          });
        }

        const parsedContext =
          query.context.kind === "workspace"
            ? null
            : parseAssetGraphNodeId(query.context.id);
        const contextCourseId =
          query.context.kind === "course" && parsedContext?.kind === "course"
            ? parsedContext.uuid
            : null;
        if (query.context.kind === "course" && (!contextCourseId || !activeCourses.has(contextCourseId))) {
          throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
        }

        const parsedPrefs = openingAdaptivePrefsSchema.safeParse(
          workspace.adaptive_planning ?? DEFAULT_OPENING_ADAPTIVE_PREFS,
        );
        const adaptivePrefsInvalid = !parsedPrefs.success;
        let allGoals: LearningGoal[];
        let conflicts: LearningGoalList["legacyConflicts"] = [];
        let courseGoalRefs: Record<string, string> = {};

        if (parsedPrefs.success) {
          const projected = await projectOpeningAdaptiveGoals(tx, validScope, parsedPrefs.data);
          allGoals = projected.goals;
          conflicts = projected.conflicts;
          courseGoalRefs = projected.prefs.courseGoalRefs ?? {};
        } else {
          allGoals = await readLearningGoals(tx, validScope);
        }

        const visibleGoalsById = new Map<string, LearningGoal>();
        for (const goal of allGoals) {
          if (goal.lifecycle === "archived") continue;
          if (!goal.courseIds.some(cid => activeCourses.has(cid))) continue;
          visibleGoalsById.set(goal.id, goal);
        }

        const contextGoalId =
          query.context.kind === "goal" && parsedContext?.kind === "goal"
            ? parsedContext.uuid
            : null;
        if (query.context.kind === "goal" && (!contextGoalId || !visibleGoalsById.has(contextGoalId))) {
          throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
        }

        const targetCourseIds =
          contextCourseId !== null
            ? [contextCourseId]
            : contextGoalId !== null
              ? visibleGoalsById
                  .get(contextGoalId)!
                  .courseIds.filter(cid => activeCourses.has(cid))
              : [...activeCourses.keys()];

        const conflictCourseIds = new Set(conflicts.map(item => item.courseId));
        const hasRelevantConflict = targetCourseIds.some(cid => conflictCourseIds.has(cid));
        const scopesPartial = adaptivePrefsInvalid || hasRelevantConflict;
        if (scopesPartial) {
          completeness = "partial";
          if (adaptivePrefsInvalid) {
            warningSet.add("工作区学习规划偏好无效，未指定目标的课程要求默认适用关系无法自动确定。");
          }
          if (hasRelevantConflict) {
            warningSet.add("部分课程存在旧目标冲突，未指定目标的课程要求默认适用关系暂无法自动推导。");
          }
        }

        const targetCourseSet = new Set(targetCourseIds);
        const requirementRows = targetCourseIds.length
          ? await tx`
              SELECT id, workspace_id, owner_user_id, course_id, stable_skill_id, knowledge_node_id,
                     requirement_key, title, position, mandatory, goal_ids, prerequisite_ids,
                     source_refs, verification, evidence_conditions, revision, lifecycle, origin,
                     approved_at, updated_at
              FROM course_requirements
              WHERE workspace_id = ${validScope.workspaceId}
                AND owner_user_id = ${validScope.ownerUserId}
                AND course_id = ANY(${targetCourseIds}::uuid[])
                AND lifecycle = 'active'
              ORDER BY course_id, position, id
            `
          : [];
        const activeRequirementsById = new Map<string, CourseRequirement>();
        const reqUpdatedAtById = new Map<string, string | null>();
        const activeRequirementsByCourse = new Map<string, CourseRequirement[]>();
        for (const row of requirementRows) {
          const req = mapCourseRequirement(row);
          if (!targetCourseSet.has(req.courseId) || req.lifecycle !== "active") continue;
          activeRequirementsById.set(req.id, req);
          reqUpdatedAtById.set(req.id, toIso(row.updated_at));
          const list = activeRequirementsByCourse.get(req.courseId) ?? [];
          list.push(req);
          activeRequirementsByCourse.set(req.courseId, list);
        }

        const loadedRequirementsByCourse = new Map<string, CourseRequirement[]>();
        for (const cid of targetCourseIds) {
          loadedRequirementsByCourse.set(cid, activeRequirementsByCourse.get(cid) ?? []);
        }
        const ensureCourseRequirementsLoaded = async (
          courseId: string,
        ): Promise<CourseRequirement[]> => {
          const cached = loadedRequirementsByCourse.get(courseId);
          if (cached) return cached;
          if (!activeCourses.has(courseId)) {
            loadedRequirementsByCourse.set(courseId, []);
            return [];
          }
          const rows = await tx`
            SELECT id, workspace_id, owner_user_id, course_id, stable_skill_id, knowledge_node_id,
                   requirement_key, title, position, mandatory, goal_ids, prerequisite_ids,
                   source_refs, verification, evidence_conditions, revision, lifecycle, origin,
                   approved_at, updated_at
            FROM course_requirements
            WHERE workspace_id = ${validScope.workspaceId}
              AND owner_user_id = ${validScope.ownerUserId}
              AND course_id = ${courseId}
              AND lifecycle = 'active'
            ORDER BY course_id, position, id
          `;
          const reqs: CourseRequirement[] = [];
          for (const row of rows) {
            const req = mapCourseRequirement(row);
            if (req.courseId !== courseId || req.lifecycle !== "active") continue;
            reqUpdatedAtById.set(req.id, toIso(row.updated_at));
            reqs.push(req);
          }
          loadedRequirementsByCourse.set(courseId, reqs);
          return reqs;
        };

        const activeCourseIds = [...activeCourses.keys()];
        const sharedSkillLinkRows =
          targetCourseIds.length && activeCourseIds.length
            ? await tx`
                SELECT l.id, l.revision, l.stable_skill_id, l.source_requirement_id,
                       l.source_requirement_revision, l.target_requirement_id,
                       l.target_requirement_revision, l.updated_at,
                       s.course_id AS source_course_id, s.title AS source_requirement_title,
                       t.course_id AS target_course_id
                FROM course_requirement_evidence_links l
                JOIN course_requirements t
                  ON t.id = l.target_requirement_id
                  AND t.workspace_id = l.workspace_id
                  AND t.owner_user_id = l.owner_user_id
                JOIN course_requirements s
                  ON s.id = l.source_requirement_id
                  AND s.workspace_id = l.workspace_id
                  AND s.owner_user_id = l.owner_user_id
                JOIN courses c
                  ON c.id = s.course_id
                  AND c.workspace_id = s.workspace_id
                  AND c.archived_at IS NULL
                WHERE l.workspace_id = ${validScope.workspaceId}
                  AND l.owner_user_id = ${validScope.ownerUserId}
                  AND l.active = true
                  AND t.course_id = ANY(${targetCourseIds}::uuid[])
                  AND s.course_id = ANY(${activeCourseIds}::uuid[])
                ORDER BY l.id
              `
            : [];
        const sharedSkillLinks: SharedSkillLinkRecord[] = sharedSkillLinkRows
          .filter(row => row.active === undefined || row.active === true)
          .map(row => ({
            id: String(row.id),
            revision: Number(row.revision),
            stableSkillId: String(row.stable_skill_id),
            sourceRequirementId: String(row.source_requirement_id),
            sourceRequirementRevision: Number(row.source_requirement_revision),
            targetRequirementId: String(row.target_requirement_id),
            targetRequirementRevision: Number(row.target_requirement_revision),
            updatedAt: toIso(row.updated_at),
            sourceCourseId: String(row.source_course_id),
            sourceRequirementTitle: normalizeLabel(row.source_requirement_title, "课程要求"),
            targetCourseId: String(row.target_course_id),
          }))
          .filter(
            link =>
              targetCourseSet.has(link.targetCourseId) &&
              activeCourses.has(link.sourceCourseId),
          );
        const sharedLinksById = new Map(sharedSkillLinks.map(link => [link.id, link]));

        // Compute context-scoped visible courses, goals, and requirements early so shared-skill sources are bounded accurately.
        const visibleCourseIds = new Set<string>(targetCourseIds);
        const visibleGoalIds = new Set<string>();
        const visibleRequirementIds = new Set<string>();
        if (query.context.kind === "workspace") {
          for (const id of visibleGoalsById.keys()) visibleGoalIds.add(id);
          for (const id of activeRequirementsById.keys()) visibleRequirementIds.add(id);
        } else if (contextCourseId !== null) {
          for (const goal of visibleGoalsById.values()) {
            if (goal.courseIds.includes(contextCourseId)) visibleGoalIds.add(goal.id);
          }
          for (const req of activeRequirementsByCourse.get(contextCourseId) ?? []) {
            visibleRequirementIds.add(req.id);
          }
        } else if (contextGoalId !== null) {
          visibleGoalIds.add(contextGoalId);
          for (const req of activeRequirementsById.values()) {
            if (!visibleCourseIds.has(req.courseId)) continue;
            const explicit = req.goalIds.includes(contextGoalId);
            const defaultApplicable =
              req.goalIds.length === 0 &&
              !adaptivePrefsInvalid &&
              !conflictCourseIds.has(req.courseId);
            if (explicit || defaultApplicable) {
              visibleRequirementIds.add(req.id);
            }
          }
        }

        const visibleSharedLinks = sharedSkillLinks.filter(link =>
          visibleRequirementIds.has(link.targetRequirementId),
        );
        const referencedSourceCourseIds = [
          ...new Set(visibleSharedLinks.map(link => link.sourceCourseId)),
        ].sort();
        const referencedSourceCourseSet = new Set(referencedSourceCourseIds);
        const referencedSourceRequirementIds = [
          ...new Set(visibleSharedLinks.map(link => link.sourceRequirementId)),
        ].sort();
        for (const sourceCid of referencedSourceCourseIds) {
          await ensureCourseRequirementsLoaded(sourceCid);
        }
        const allRelevantCourseIds = [
          ...new Set([...targetCourseIds, ...referencedSourceCourseIds]),
        ];
        const allRelevantCourseSet = new Set(allRelevantCourseIds);

        const knowledgeRows = targetCourseIds.length
          ? await tx`
              SELECT course_id, version, snapshot, updated_at
              FROM opening_course_knowledge
              WHERE workspace_id = ${validScope.workspaceId}
                AND owner_user_id = ${validScope.ownerUserId}
                AND course_id = ANY(${targetCourseIds}::uuid[])
              ORDER BY course_id
            `
          : [];
        const knowledgeSnapshotsByCourse = new Map<
          string,
          { snapshot: KnowledgeSnapshot; updatedAt: string | null }
        >();
        for (const row of knowledgeRows) {
          const courseId = String(row.course_id);
          if (!targetCourseSet.has(courseId)) continue;
          const parsedSnapshot = knowledgeSnapshotSchema.safeParse(row.snapshot);
          if (!parsedSnapshot.success || parsedSnapshot.data.courseId !== courseId) {
            completeness = "partial";
            warningSet.add("部分课程知识快照格式无效，已安全跳过损坏的知识节点。");
            continue;
          }
          knowledgeSnapshotsByCourse.set(courseId, {
            snapshot: parsedSnapshot.data,
            updatedAt: toIso(row.updated_at),
          });
        }

        const sourceRows = await tx`
          SELECT s.id, s.name, s.version, s.upload_state, s.parse_state, s.updated_at,
                 EXISTS (
                   SELECT 1 FROM opening_privacy_exclusions e
                   WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
                 ) AS ai_excluded
          FROM opening_sources s
          WHERE s.workspace_id = ${validScope.workspaceId}
            AND s.upload_state = 'uploaded'
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id = s.workspace_id
                AND e.source_id = s.id
                AND e.asset_deleted_at IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM opening_source_versions v
              WHERE v.workspace_id = s.workspace_id
                AND v.source_id = s.id
                AND v.version = s.version
                AND v.availability = 'unavailable'
            )
          ORDER BY s.id
        `;
        const workspaceSources = new Map<string, SourceRecord>();
        for (const row of sourceRows) {
          const id = String(row.id);
          workspaceSources.set(id, {
            id,
            name: normalizeLabel(row.name, "未命名资料"),
            version: Number(row.version),
            uploadState: String(row.upload_state),
            parseState: String(row.parse_state),
            aiExcluded: row.ai_excluded === true,
            updatedAt: toIso(row.updated_at),
          });
        }

        const exclusionRows = await tx`
          SELECT source_id
          FROM opening_privacy_exclusions
          WHERE workspace_id = ${validScope.workspaceId}
          ORDER BY source_id
        `;
        const excludedSourceIds = new Set(exclusionRows.map(row => String(row.source_id)));

        const allSourceRows = await tx`
          SELECT id
          FROM opening_sources
          WHERE workspace_id = ${validScope.workspaceId}
          ORDER BY id
        `;
        const existingSourceIds = new Set(allSourceRows.map(row => String(row.id)));

        const documentRows = await tx`
          SELECT d.id, d.title, d.lifecycle, d.current_revision_number, d.updated_at
          FROM library_documents d
          WHERE d.workspace_id = ${validScope.workspaceId}
            AND d.deleted_at IS NULL
            AND ${openingNoteReadable(tx, validScope.workspaceId, tx`d.id`)}
          ORDER BY d.id
        `;
        const workspaceDocuments = new Map<string, DocumentRecord>();
        for (const row of documentRows) {
          const id = String(row.id);
          workspaceDocuments.set(id, {
            id,
            title: normalizeLabel(row.title, "未命名笔记"),
            lifecycle: String(row.lifecycle),
            currentRevisionNumber: Number(row.current_revision_number ?? 0),
            updatedAt: toIso(row.updated_at),
          });
        }

        const explorationRows = await tx`
          SELECT id, title, status, course_id, goal_id, updated_at
          FROM explorations
          WHERE workspace_id = ${validScope.workspaceId}
            AND owner_user_id = ${validScope.ownerUserId}
          ORDER BY id
        `;
        const workspaceExplorations = new Map<string, ExplorationRecord>();
        for (const row of explorationRows) {
          const id = String(row.id);
          workspaceExplorations.set(id, {
            id,
            title: normalizeLabel(row.title, "自由探索"),
            status: String(row.status),
            courseId: row.course_id ? String(row.course_id) : null,
            goalId: row.goal_id ? String(row.goal_id) : null,
            updatedAt: toIso(row.updated_at),
          });
        }

        const membershipRows = allRelevantCourseIds.length
          ? await tx`
              SELECT id, course_id, asset_type, asset_id, updated_at
              FROM course_asset_memberships
              WHERE workspace_id = ${validScope.workspaceId}
                AND course_id = ANY(${allRelevantCourseIds}::uuid[])
              ORDER BY id
            `
          : [];
        const memberships: MembershipRecord[] = membershipRows
          .filter(row => allRelevantCourseSet.has(String(row.course_id)))
          .map(row => ({
            id: String(row.id),
            courseId: String(row.course_id),
            assetType: String(row.asset_type),
            assetId: String(row.asset_id),
            updatedAt: toIso(row.updated_at),
          }));

        const assetLinkRows = await tx`
          SELECT id, asset_type, asset_id, course_id, goal_id, requirement_id, revision, updated_at
          FROM opening_learning_asset_links
          WHERE workspace_id = ${validScope.workspaceId}
            AND owner_user_id = ${validScope.ownerUserId}
            AND status = 'active'
          ORDER BY id
        `;
        const assetLinks: AssetLinkRecord[] = assetLinkRows
          .filter(row => row.asset_type === "source" || row.asset_type === "document")
          .map(row => ({
            id: String(row.id),
            assetType: row.asset_type as "source" | "document",
            assetId: String(row.asset_id),
            courseId: row.course_id ? String(row.course_id) : null,
            goalId: row.goal_id ? String(row.goal_id) : null,
            requirementId: row.requirement_id ? String(row.requirement_id) : null,
            revision: Number(row.revision),
            updatedAt: toIso(row.updated_at),
          }));

        const promotionRows = await tx`
          SELECT id, exploration_id, target_id, reviewed_at, updated_at
          FROM promotion_records
          WHERE workspace_id = ${validScope.workspaceId}
            AND status = 'accepted'
            AND target_type = 'document'
            AND target_id IS NOT NULL
          ORDER BY id
        `;
        const promotions: PromotionRecord[] = promotionRows.map(row => ({
          id: String(row.id),
          explorationId: String(row.exploration_id),
          targetId: String(row.target_id),
          reviewedAt: toIso(row.reviewed_at),
          updatedAt: toIso(row.updated_at),
        }));

        const observationHeaderRows = allRelevantCourseIds.length
          ? await tx`
              SELECT o.id, o.course_id, COALESCE(o.root_observation_id, o.id) AS root_id,
                     o.history_revision, o.workspace_history_revision,
                     o.occurred_at, o.submitted_at, o.recorded_at,
                     o.requirement_key,
                     v.evaluation_spec->'courseRequirement'->>'id' AS eval_req_id
              FROM opening_learning_observations o
              JOIN opening_learning_observations root
                ON root.id = COALESCE(o.root_observation_id, o.id)
                AND root.workspace_id = o.workspace_id
                AND root.owner_user_id = o.owner_user_id
                AND COALESCE(root.effective_head_id, root.id) = o.id
              LEFT JOIN opening_learning_item_versions v
                ON v.id = o.item_version_id
                AND v.workspace_id = o.workspace_id
                AND v.owner_user_id = o.owner_user_id
              WHERE o.workspace_id = ${validScope.workspaceId}
                AND o.owner_user_id = ${validScope.ownerUserId}
                AND o.course_id = ANY(${allRelevantCourseIds}::uuid[])
                AND COALESCE(o.revision_kind, 'original') <> 'retract'
              ORDER BY o.id
            `
          : [];
        const observationHeaders: ObservationHeaderRecord[] = observationHeaderRows
          .filter(row => allRelevantCourseSet.has(String(row.course_id)))
          .map(row => ({
            id: String(row.id),
            courseId: String(row.course_id),
            rootId: String(row.root_id),
            historyRevision: Number(row.history_revision ?? 0),
            workspaceHistoryRevision: Number(row.workspace_history_revision ?? 0),
            occurredAt: toIso(row.occurred_at),
            submittedAt: toIso(row.submitted_at),
            recordedAt: toIso(row.recorded_at),
            requirementKey: row.requirement_key == null ? null : String(row.requirement_key),
            evalReqId: row.eval_req_id == null ? null : String(row.eval_req_id),
          }));
        const observationHeaderById = new Map(observationHeaders.map(row => [row.id, row]));

        // Compute remaining context-scoped visible sets for knowledge/source/document/exploration nodes.
        const visibleKnowledgeNodeIds = new Set<string>();
        const visibleSourceIds = new Set<string>();
        const visibleDocumentIds = new Set<string>();
        const visibleExplorationIds = new Set<string>();

        if (query.context.kind === "workspace") {
          for (const [courseId, entry] of knowledgeSnapshotsByCourse) {
            for (const node of entry.snapshot.nodes) {
              visibleKnowledgeNodeIds.add(
                formatAssetGraphNodeId({ kind: "knowledge", courseId, nodeId: node.id }),
              );
            }
          }
          for (const id of workspaceSources.keys()) visibleSourceIds.add(id);
          for (const id of workspaceDocuments.keys()) visibleDocumentIds.add(id);
          for (const id of workspaceExplorations.keys()) visibleExplorationIds.add(id);
        } else if (contextCourseId !== null) {
          for (const req of activeRequirementsByCourse.get(contextCourseId) ?? []) {
            for (const ref of req.sourceRefs) {
              if (workspaceSources.has(ref.sourceId)) visibleSourceIds.add(ref.sourceId);
            }
          }
          const knowledge = knowledgeSnapshotsByCourse.get(contextCourseId);
          if (knowledge) {
            for (const node of knowledge.snapshot.nodes) {
              visibleKnowledgeNodeIds.add(
                formatAssetGraphNodeId({ kind: "knowledge", courseId: contextCourseId, nodeId: node.id }),
              );
            }
          }
          for (const membership of memberships) {
            if (membership.courseId !== contextCourseId) continue;
            if (membership.assetType === "source" && workspaceSources.has(membership.assetId)) {
              visibleSourceIds.add(membership.assetId);
            } else if (
              membership.assetType === "document" &&
              workspaceDocuments.has(membership.assetId)
            ) {
              visibleDocumentIds.add(membership.assetId);
            }
          }
          for (const link of assetLinks) {
            const targetNodeId = resolveAssetLinkTargetNodeId(link);
            if (!targetNodeId) continue;
            const parsedTarget = parseAssetGraphNodeId(targetNodeId);
            if (!parsedTarget) continue;
            const targetInScope =
              (parsedTarget.kind === "course" && parsedTarget.uuid === contextCourseId) ||
              (parsedTarget.kind === "goal" && visibleGoalIds.has(parsedTarget.uuid)) ||
              (parsedTarget.kind === "requirement" && visibleRequirementIds.has(parsedTarget.uuid));
            if (!targetInScope) continue;
            if (link.assetType === "source" && workspaceSources.has(link.assetId)) {
              visibleSourceIds.add(link.assetId);
            } else if (link.assetType === "document" && workspaceDocuments.has(link.assetId)) {
              visibleDocumentIds.add(link.assetId);
            }
          }
          for (const exp of workspaceExplorations.values()) {
            if (exp.courseId === contextCourseId) visibleExplorationIds.add(exp.id);
          }
          for (const promo of promotions) {
            if (
              workspaceExplorations.has(promo.explorationId) &&
              visibleDocumentIds.has(promo.targetId)
            ) {
              visibleExplorationIds.add(promo.explorationId);
            }
          }
        } else if (contextGoalId !== null) {
          for (const rid of visibleRequirementIds) {
            const req = activeRequirementsById.get(rid);
            if (!req) continue;
            if (req.knowledgeNodeId) {
              const knEntry = knowledgeSnapshotsByCourse.get(req.courseId);
              if (knEntry?.snapshot.nodes.some(node => node.id === req.knowledgeNodeId)) {
                visibleKnowledgeNodeIds.add(
                  formatAssetGraphNodeId({
                    kind: "knowledge",
                    courseId: req.courseId,
                    nodeId: req.knowledgeNodeId,
                  }),
                );
              }
            }
            for (const ref of req.sourceRefs) {
              if (workspaceSources.has(ref.sourceId)) visibleSourceIds.add(ref.sourceId);
            }
          }
          const initialDocIds = new Set<string>();
          for (const link of assetLinks) {
            const targetNodeId = resolveAssetLinkTargetNodeId(link);
            if (!targetNodeId) continue;
            const parsedTarget = parseAssetGraphNodeId(targetNodeId);
            if (!parsedTarget) continue;
            const targetInGoal =
              (parsedTarget.kind === "goal" && parsedTarget.uuid === contextGoalId) ||
              (parsedTarget.kind === "requirement" && visibleRequirementIds.has(parsedTarget.uuid));
            if (!targetInGoal) continue;
            if (link.assetType === "source" && workspaceSources.has(link.assetId)) {
              visibleSourceIds.add(link.assetId);
            } else if (link.assetType === "document" && workspaceDocuments.has(link.assetId)) {
              initialDocIds.add(link.assetId);
              visibleDocumentIds.add(link.assetId);
            }
          }
          const initialExpIds = new Set<string>();
          for (const exp of workspaceExplorations.values()) {
            if (exp.goalId === contextGoalId) {
              initialExpIds.add(exp.id);
              visibleExplorationIds.add(exp.id);
            }
          }
          for (const promo of promotions) {
            if (!workspaceExplorations.has(promo.explorationId)) continue;
            if (!workspaceDocuments.has(promo.targetId)) continue;
            if (initialExpIds.has(promo.explorationId)) {
              visibleDocumentIds.add(promo.targetId);
            }
            if (initialDocIds.has(promo.targetId)) {
              visibleExplorationIds.add(promo.explorationId);
            }
          }
        }

        // Build visibleNodeMap for the 7 non-observation node kinds.
        const visibleNodeMap = new Map<string, AssetGraphNode>();

        for (const cid of visibleCourseIds) {
          const course = activeCourses.get(cid);
          if (!course) continue;
          const id = formatAssetGraphNodeId({ kind: "course", uuid: cid });
          visibleNodeMap.set(id, { id, kind: "course", label: course.title });
        }
        for (const gid of visibleGoalIds) {
          const goal = visibleGoalsById.get(gid);
          if (!goal) continue;
          const id = formatAssetGraphNodeId({ kind: "goal", uuid: gid });
          visibleNodeMap.set(id, {
            id,
            kind: "goal",
            label: normalizeLabel(goal.title, "学习目标"),
          });
        }
        for (const rid of visibleRequirementIds) {
          const req = activeRequirementsById.get(rid);
          if (!req) continue;
          const id = formatAssetGraphNodeId({ kind: "requirement", uuid: rid });
          visibleNodeMap.set(id, {
            id,
            kind: "requirement",
            label: normalizeLabel(req.title, req.requirementKey),
          });
        }
        for (const knNodeId of visibleKnowledgeNodeIds) {
          const parsedKn = parseAssetGraphNodeId(knNodeId);
          if (parsedKn?.kind !== "knowledge") continue;
          const knEntry = knowledgeSnapshotsByCourse.get(parsedKn.courseId);
          const kn = knEntry?.snapshot.nodes.find(item => item.id === parsedKn.nodeId);
          if (!kn) continue;
          visibleNodeMap.set(knNodeId, {
            id: knNodeId,
            kind: "knowledge",
            label: normalizeLabel(kn.label, "知识节点"),
            meta: { knowledgeStatus: kn.status },
          });
        }
        for (const sid of visibleSourceIds) {
          const src = workspaceSources.get(sid);
          if (!src) continue;
          const id = formatAssetGraphNodeId({ kind: "source", uuid: sid });
          visibleNodeMap.set(id, {
            id,
            kind: "source",
            label: src.name,
            meta: { version: src.version },
          });
        }
        for (const did of visibleDocumentIds) {
          const doc = workspaceDocuments.get(did);
          if (!doc) continue;
          const id = formatAssetGraphNodeId({ kind: "document", uuid: did });
          visibleNodeMap.set(id, { id, kind: "document", label: doc.title });
        }
        for (const eid of visibleExplorationIds) {
          const exp = workspaceExplorations.get(eid);
          if (!exp) continue;
          const id = formatAssetGraphNodeId({ kind: "exploration", uuid: eid });
          visibleNodeMap.set(id, { id, kind: "exploration", label: exp.title });
        }

        // Lazy per-course material & chunk loaders (also used in shared-skill scopeFingerprint binding).
        const courseMaterialsCache = new Map<
          string,
          Awaited<ReturnType<typeof readCourseRouteMaterials>>
        >();
        const ensureCourseMaterialsLoaded = async (courseId: string) => {
          const cached = courseMaterialsCache.get(courseId);
          if (cached) return cached;
          const materials = await readCourseRouteMaterials(tx, validScope, courseId);
          courseMaterialsCache.set(courseId, materials);
          return materials;
        };

        const courseChunksCache = new Map<
          string,
          Awaited<ReturnType<typeof readCourseRouteSourceChunks>>
        >();
        const ensureCourseSourceChunksLoaded = async (courseId: string) => {
          const cached = courseChunksCache.get(courseId);
          if (cached) return cached;
          const chunks = await readCourseRouteSourceChunks(tx, validScope, courseId);
          courseChunksCache.set(courseId, chunks);
          return chunks;
        };

        for (const sourceCid of referencedSourceCourseIds) {
          await ensureCourseMaterialsLoaded(sourceCid);
          await ensureCourseSourceChunksLoaded(sourceCid);
        }

        const loadedSourceReqById = new Map<string, CourseRequirement>();
        for (const cid of referencedSourceCourseIds) {
          for (const req of loadedRequirementsByCourse.get(cid) ?? []) {
            loadedSourceReqById.set(req.id, req);
          }
        }
        const sharedSourceRequirementsForFingerprint = referencedSourceRequirementIds
          .map(id => loadedSourceReqById.get(id))
          .filter((r): r is CourseRequirement => Boolean(r))
          .map(r => ({
            id: r.id,
            courseId: r.courseId,
            revision: r.revision,
            lifecycle: r.lifecycle,
            approvedAt: r.approvedAt,
            sourceRefs: r.sourceRefs,
            verification: r.verification,
            evidenceConditions: r.evidenceConditions ?? null,
            updatedAt: reqUpdatedAtById.get(r.id) ?? null,
          }));
        const referencedSourceMaterialIds = new Set<string>();
        for (const r of sharedSourceRequirementsForFingerprint) {
          for (const ref of r.sourceRefs) {
            referencedSourceMaterialIds.add(ref.sourceId);
          }
        }
        for (const m of memberships) {
          if (referencedSourceCourseSet.has(m.courseId) && m.assetType === "source") {
            referencedSourceMaterialIds.add(m.assetId);
          }
        }

        // Compute deterministic context-scoped fingerprint BEFORE cursor validation.
        const visibleRequirementKeys = new Set(
          [...visibleRequirementIds]
            .map(rid => activeRequirementsById.get(rid)?.requirementKey)
            .filter((k): k is string => typeof k === "string"),
        );
        const localObsHeaders = observationHeaders.filter(h => targetCourseSet.has(h.courseId));
        const scopedObsHeaders =
          query.context.kind === "goal"
            ? localObsHeaders.filter(
                h =>
                  (h.requirementKey !== null && visibleRequirementKeys.has(h.requirementKey)) ||
                  (h.evalReqId !== null && visibleRequirementIds.has(h.evalReqId)),
              )
            : localObsHeaders;

        const scopeFingerprint = hashAssetGraphScopeFingerprint({
          privacyEpoch,
          context: query.context,
          adaptivePrefsInvalid,
          scopesPartial,
          courses: [...visibleCourseIds]
            .sort()
            .map(id => activeCourses.get(id)),
          goals: [...visibleGoalIds]
            .sort()
            .map(id => {
              const g = visibleGoalsById.get(id)!;
              return {
                id: g.id,
                revision: g.revision,
                lifecycle: g.lifecycle,
                title: g.title,
                courseIds: g.courseIds,
                updatedAt: g.updatedAt,
              };
            }),
          requirements: [...visibleRequirementIds]
            .sort()
            .map(id => {
              const r = activeRequirementsById.get(id)!;
              return {
                id: r.id,
                courseId: r.courseId,
                revision: r.revision,
                lifecycle: r.lifecycle,
                title: r.title,
                approvedAt: r.approvedAt,
                knowledgeNodeId: r.knowledgeNodeId,
                goalIds: r.goalIds,
                sourceRefs: r.sourceRefs,
                verification: r.verification,
                evidenceConditions: r.evidenceConditions ?? null,
                updatedAt: reqUpdatedAtById.get(id) ?? null,
              };
            }),
          knowledge: [...visibleCourseIds]
            .sort()
            .flatMap(cid => {
              const entry = knowledgeSnapshotsByCourse.get(cid);
              if (!entry) return [];
              return [
                {
                  courseId: cid,
                  version: entry.snapshot.version,
                  updatedAt: entry.updatedAt,
                  nodeIds: entry.snapshot.nodes
                    .map(n => formatAssetGraphNodeId({ kind: "knowledge", courseId: cid, nodeId: n.id }))
                    .filter(nid => visibleKnowledgeNodeIds.has(nid))
                    .sort(),
                },
              ];
            }),
          sources: [...visibleSourceIds]
            .sort()
            .map(id => workspaceSources.get(id)),
          documents: [...visibleDocumentIds]
            .sort()
            .map(id => workspaceDocuments.get(id)),
          explorations: [...visibleExplorationIds]
            .sort()
            .map(id => workspaceExplorations.get(id)),
          memberships: memberships
            .filter(m => visibleCourseIds.has(m.courseId))
            .map(m => ({ id: m.id, courseId: m.courseId, assetType: m.assetType, assetId: m.assetId, updatedAt: m.updatedAt })),
          assetLinks: assetLinks
            .filter(l => {
              const target = resolveAssetLinkTargetNodeId(l);
              return target !== null && visibleNodeMap.has(target);
            })
            .map(l => ({
              id: l.id,
              assetType: l.assetType,
              assetId: l.assetId,
              courseId: l.courseId,
              goalId: l.goalId,
              requirementId: l.requirementId,
              revision: l.revision,
              updatedAt: l.updatedAt,
            })),
          promotions: promotions
            .filter(
              p =>
                visibleExplorationIds.has(p.explorationId) &&
                visibleDocumentIds.has(p.targetId),
            )
            .map(p => ({
              id: p.id,
              explorationId: p.explorationId,
              targetId: p.targetId,
              reviewedAt: p.reviewedAt,
              updatedAt: p.updatedAt,
            })),
          observations: scopedObsHeaders.map(h => ({
            id: h.id,
            courseId: h.courseId,
            rootId: h.rootId,
            historyRevision: h.historyRevision,
            workspaceHistoryRevision: h.workspaceHistoryRevision,
            occurredAt: h.occurredAt,
            submittedAt: h.submittedAt,
            recordedAt: h.recordedAt,
          })),
          sharedLinks: visibleSharedLinks.map(l => ({
            id: l.id,
            revision: l.revision,
            stableSkillId: l.stableSkillId,
            sourceRequirementId: l.sourceRequirementId,
            sourceRequirementRevision: l.sourceRequirementRevision,
            targetRequirementId: l.targetRequirementId,
            targetRequirementRevision: l.targetRequirementRevision,
            updatedAt: l.updatedAt,
          })),
          sharedSourceRequirements: sharedSourceRequirementsForFingerprint,
          sharedSourceMaterials: [...referencedSourceMaterialIds]
            .sort()
            .map(id => ({
              id,
              source: workspaceSources.get(id) ?? null,
              excluded: excludedSourceIds.has(id),
            })),
          sharedSourceRouteMaterials: referencedSourceCourseIds.map(cid => ({
            courseId: cid,
            materials: [...(courseMaterialsCache.get(cid) ?? [])].sort((a, b) =>
              compareStrings(a.sourceId, b.sourceId),
            ),
          })),
          sharedSourceChunks: referencedSourceCourseIds.map(cid => ({
            courseId: cid,
            chunks: [...(courseChunksCache.get(cid) ?? [])].sort((a, b) =>
              compareStrings(a.id, b.id),
            ),
          })),
          sharedSourceMemberships: memberships
            .filter(m => referencedSourceCourseSet.has(m.courseId))
            .map(m => ({
              id: m.id,
              courseId: m.courseId,
              assetType: m.assetType,
              assetId: m.assetId,
              updatedAt: m.updatedAt,
            })),
          sharedSourceObservations: observationHeaders
            .filter(h => referencedSourceCourseSet.has(h.courseId))
            .map(h => ({
              id: h.id,
              courseId: h.courseId,
              rootId: h.rootId,
              historyRevision: h.historyRevision,
              workspaceHistoryRevision: h.workspaceHistoryRevision,
              occurredAt: h.occurredAt,
              submittedAt: h.submittedAt,
              recordedAt: h.recordedAt,
            })),
          selectedGoalRefs: [...visibleCourseIds]
            .sort()
            .map(cid => [cid, courseGoalRefs[cid] ?? null]),
        });

        // Lazy per-course observation & summary loaders inside this repeatable-read tx.
        const courseObservationsCache = new Map<string, LoadedCourseObservations>();
        const visibleObservationsByNodeId = new Map<
          string,
          {
            courseId: string;
            node: AssetGraphNode;
            matchedRequirementIds: Set<string>;
            sharedAttributionsByTargetReqId: Map<string, AssetGraphSharedAttribution[]>;
          }
        >();

        const ensureCourseObservationsLoaded = async (
          courseId: string,
        ): Promise<LoadedCourseObservations> => {
          const cached = courseObservationsCache.get(courseId);
          if (cached) return cached;

          const { raw, projected } = await readCourseRouteObservations(tx, validScope, courseId, false);
          const rootIds = [...new Set(raw.map(row => row.rootObservationId ?? row.id))];
          const chainRows = rootIds.length
            ? await tx`
                SELECT COALESCE(o.root_observation_id, o.id) AS root_id,
                       o.source_ids, o.source_versions, o.reference_source_id,
                       o.reference_check->>'referenceId' AS ref_check_source_id,
                       iv.source_id AS item_source_id,
                       att.source_ids AS attempt_source_ids,
                       att.source_versions AS attempt_source_versions
                FROM opening_learning_observations o
                LEFT JOIN opening_learning_item_versions iv
                  ON iv.id = o.item_version_id
                  AND iv.workspace_id = o.workspace_id
                  AND iv.owner_user_id = o.owner_user_id
                LEFT JOIN opening_learning_attempts att
                  ON att.id = o.attempt_id
                  AND att.workspace_id = o.workspace_id
                  AND att.owner_user_id = o.owner_user_id
                WHERE o.workspace_id = ${validScope.workspaceId}
                  AND o.owner_user_id = ${validScope.ownerUserId}
                  AND COALESCE(o.root_observation_id, o.id) = ANY(${rootIds}::uuid[])
              `
            : [];

          const sourcesByRoot = new Map<string, Set<string>>();
          for (const row of chainRows) {
            const rootId = String(row.root_id);
            const set = sourcesByRoot.get(rootId) ?? new Set<string>();
            collectSourceIdsFromValue(row.source_ids, set);
            collectSourceIdsFromValue(row.source_versions, set);
            if (typeof row.reference_source_id === "string") set.add(row.reference_source_id);
            if (typeof row.ref_check_source_id === "string") set.add(row.ref_check_source_id);
            if (typeof row.item_source_id === "string") set.add(row.item_source_id);
            collectSourceIdsFromValue(row.attempt_source_ids, set);
            collectSourceIdsFromValue(row.attempt_source_versions, set);
            sourcesByRoot.set(rootId, set);
          }

          const blockedRootIds = new Set<string>();
          for (const obs of raw) {
            const rootId = obs.rootObservationId ?? obs.id;
            const refs = new Set<string>(sourcesByRoot.get(rootId) ?? []);
            // Also include in-memory raw references when chainRows is empty in unit tests.
            collectSourceIdsFromValue(obs.sourceIds, refs);
            collectSourceIdsFromValue(obs.sourceVersions, refs);
            if (obs.referenceSourceId) refs.add(obs.referenceSourceId);
            if (obs.referenceCheck?.referenceId) refs.add(obs.referenceCheck.referenceId);

            for (const sid of refs) {
              if (excludedSourceIds.has(sid) || !existingSourceIds.has(sid)) {
                blockedRootIds.add(rootId);
                break;
              }
            }
          }

          const filteredRaw = raw.filter(
            obs => !blockedRootIds.has(obs.rootObservationId ?? obs.id),
          );
          const filteredRawById = new Map(filteredRaw.map(obs => [obs.id, obs]));
          const filteredProjected = projected.filter(obs => filteredRawById.has(obs.id));

          // Register observation nodes visible in the current context.
          const projectedByObsId = new Map<string, ExamCourseRouteObservation[]>();
          for (const item of filteredProjected) {
            const list = projectedByObsId.get(item.id) ?? [];
            list.push(item);
            projectedByObsId.set(item.id, list);
          }

          for (const rawObs of filteredRaw) {
            const entries = projectedByObsId.get(rawObs.id) ?? [];
            const matchedReqIds = new Set<string>();
            for (const entry of entries) {
              for (const rid of visibleRequirementIds) {
                const req = activeRequirementsById.get(rid);
                if (req && req.courseId === courseId && matchesRequirementIdentity(entry, req)) {
                  matchedReqIds.add(rid);
                }
              }
            }

            // In course/goal context, only locally qualified observations attributed to an in-scope requirement are visible.
            if (query.context.kind !== "workspace" && matchedReqIds.size === 0) {
              continue;
            }

            const assistanceValues = new Set(entries.map(entry => entry.assistance));
            const assistance =
              assistanceValues.size === 1
                ? [...assistanceValues][0]!
                : rawObs.assistance;
            const occurredAt = rawObs.submittedAt ?? rawObs.occurredAt;
            const obsNodeId = formatAssetGraphNodeId({ kind: "observation", uuid: rawObs.id });
            const existingObs = visibleObservationsByNodeId.get(obsNodeId);
            if (existingObs) {
              for (const rid of matchedReqIds) existingObs.matchedRequirementIds.add(rid);
              continue;
            }
            const obsNode: AssetGraphNode = {
              id: obsNodeId,
              kind: "observation",
              label: observationLabel(assistance),
              meta: { occurredAt, assistance },
            };
            visibleNodeMap.set(obsNodeId, obsNode);
            visibleObservationsByNodeId.set(obsNodeId, {
              courseId,
              node: obsNode,
              matchedRequirementIds: matchedReqIds,
              sharedAttributionsByTargetReqId: new Map(),
            });
          }

          const loaded = { filteredRaw, filteredProjected };
          courseObservationsCache.set(courseId, loaded);
          return loaded;
        };

        const sharedEvidenceCache = new Map<
          string,
          Awaited<ReturnType<typeof readSharedCourseEvidence>>
        >();
        const sharedAttributionsByReqId = new Map<string, AssetGraphSharedAttribution[]>();

        const ensureSharedEvidenceLoaded = async (targetCourseId: string) => {
          const cached = sharedEvidenceCache.get(targetCourseId);
          if (cached) return cached;

          const sharedEvidence = await readSharedCourseEvidence(tx, validScope, targetCourseId, {
            requirements: ensureCourseRequirementsLoaded,
            observations: async cid => {
              const loaded = await ensureCourseObservationsLoaded(cid);
              return { projected: loaded.filteredProjected };
            },
            sources: ensureCourseMaterialsLoaded,
            chunks: ensureCourseSourceChunksLoaded,
          });

          for (const obs of sharedEvidence) {
            for (const ref of obs.sharedFor ?? []) {
              if (!visibleRequirementIds.has(ref.requirementId)) continue;
              const targetReq = activeRequirementsById.get(ref.requirementId);
              if (!targetReq || targetReq.courseId !== targetCourseId) continue;

              const link = sharedLinksById.get(ref.linkId);
              if (
                !link ||
                link.targetCourseId !== targetCourseId ||
                link.targetRequirementId !== ref.requirementId ||
                link.sourceCourseId !== ref.sourceCourseId ||
                link.sourceRequirementId !== ref.sourceRequirementId ||
                link.targetRequirementRevision !== ref.requirementRevision ||
                link.stableSkillId !== ref.stableSkillId
              ) {
                continue;
              }

              const sourceCourse = activeCourses.get(ref.sourceCourseId);
              if (!sourceCourse) continue;

              const sourceReqs = await ensureCourseRequirementsLoaded(ref.sourceCourseId);
              const sourceReq = sourceReqs.find(r => r.id === ref.sourceRequirementId);
              const sourceRequirementTitle = normalizeLabel(
                link.sourceRequirementTitle,
                sourceReq?.title ?? "课程要求",
              );

              const attr: AssetGraphSharedAttribution = {
                linkId: link.id,
                linkRevision: link.revision,
                stableSkillId: ref.stableSkillId,
                sourceCourseId: ref.sourceCourseId,
                sourceCourseTitle: sourceCourse.title,
                sourceRequirementId: ref.sourceRequirementId,
                sourceRequirementTitle,
                sourceRequirementRevision: link.sourceRequirementRevision,
                targetRequirementRevision: link.targetRequirementRevision,
                effective: true,
              };

              const reqAttrList = sharedAttributionsByReqId.get(ref.requirementId) ?? [];
              if (!reqAttrList.some(existing => existing.linkId === attr.linkId)) {
                reqAttrList.push(attr);
                sharedAttributionsByReqId.set(ref.requirementId, reqAttrList);
              }

              const obsNodeId = formatAssetGraphNodeId({ kind: "observation", uuid: obs.id });
              let obsEntry = visibleObservationsByNodeId.get(obsNodeId);
              if (!obsEntry) {
                const sourceObs = courseObservationsCache.get(ref.sourceCourseId);
                const rawObs = sourceObs?.filteredRaw.find(row => row.id === obs.id);
                const header = observationHeaderById.get(obs.id);
                const rawOccurredAt =
                  rawObs?.submittedAt ??
                  rawObs?.occurredAt ??
                  header?.submittedAt ??
                  header?.occurredAt ??
                  obs.attemptedAt;
                const occurredAt = toIso(rawOccurredAt) ?? obs.attemptedAt;
                const obsNode: AssetGraphNode = {
                  id: obsNodeId,
                  kind: "observation",
                  label: observationLabel(obs.assistance),
                  meta: { occurredAt, assistance: obs.assistance },
                };
                visibleNodeMap.set(obsNodeId, obsNode);
                obsEntry = {
                  courseId: ref.sourceCourseId,
                  node: obsNode,
                  matchedRequirementIds: new Set<string>(),
                  sharedAttributionsByTargetReqId: new Map<
                    string,
                    AssetGraphSharedAttribution[]
                  >(),
                };
                visibleObservationsByNodeId.set(obsNodeId, obsEntry);
              }

              const obsAttrList =
                obsEntry.sharedAttributionsByTargetReqId.get(ref.requirementId) ?? [];
              if (!obsAttrList.some(existing => existing.linkId === attr.linkId)) {
                obsAttrList.push(attr);
                obsEntry.sharedAttributionsByTargetReqId.set(ref.requirementId, obsAttrList);
              }
            }
          }

          sharedEvidenceCache.set(targetCourseId, sharedEvidence);
          return sharedEvidence;
        };

        // Compute summary & missing-material metadata per course in batch.
        const courseSummaryCache = new Map<
          string,
          Map<
            string,
            {
              summary: AssetGraphStateSummary;
              sourcesAvailable: boolean;
              missingReasons: string[];
            }
          >
        >();

        const ensureCourseSummaries = async (courseId: string) => {
          const cached = courseSummaryCache.get(courseId);
          if (cached) return cached;

          const localObs = await ensureCourseObservationsLoaded(courseId);
          const courseReqs = activeRequirementsByCourse.get(courseId) ?? [];
          const materials = await ensureCourseMaterialsLoaded(courseId);
          const chunks = await ensureCourseSourceChunksLoaded(courseId);
          const sharedEvidence = await ensureSharedEvidenceLoaded(courseId);

          const progressList = courseRequirementProgress(
            courseReqs,
            [...localObs.filteredProjected, ...sharedEvidence],
            new Map(
              materials
                .filter(item => item.available)
                .map(item => [item.sourceId, item.sourceVersion]),
            ),
            chunks,
          );
          const progressByReqId = new Map(progressList.map(item => [item.requirement.id, item]));

          const learnerState = await readOpeningLearnerState(tx, validScope, { courseId });

          // Collect candidate single-head features per requirement to check solution delivery in one batch.
          const candidateHeads = new Map<
            string,
            {
              feature: (typeof learnerState.features)[number];
              projectedObs: ExamCourseRouteObservation | undefined;
              dueRetest: boolean;
            }
          >();
          const attemptIdsToCheck = new Set<string>();
          const resultMap = new Map<
            string,
            {
              summary: AssetGraphStateSummary;
              sourcesAvailable: boolean;
              missingReasons: string[];
            }
          >();

          for (const req of courseReqs) {
            const progress = progressByReqId.get(req.id);
            const requirementStatus: AssetGraphRequirementStatus | null = progress?.status ?? null;
            const matchedObsIds = new Set(
              localObs.filteredProjected
                .filter(obs => matchesRequirementIdentity(obs, req))
                .map(obs => obs.id),
            );
            const matchedFeatures = learnerState.features.filter(
              feature =>
                feature.courseId === courseId &&
                feature.requirementKey === req.requirementKey &&
                matchedObsIds.has(feature.observationId),
            );

            if (matchedFeatures.length === 0) {
              const hasQualifiedShared = sharedEvidence.some(
                obs =>
                  obs.verifiedCorrect === "yes" &&
                  obs.independentAttempt === "yes" &&
                  obs.assistance === "independent" &&
                  obs.usableForCurrentVersion === "yes" &&
                  obs.sharedFor?.some(
                    ref =>
                      ref.requirementId === req.id &&
                      ref.requirementRevision === req.revision &&
                      ref.stableSkillId === req.stableSkillId,
                  ),
              );
              if (hasQualifiedShared && progress?.status === "verified") {
                const displayReq = learnerState.display.requirements.find(
                  item => item.courseId === courseId && item.requirementKey === req.requirementKey,
                );
                const dueRetest = displayReq?.dueRetest ?? false;
                resultMap.set(req.id, {
                  summary: {
                    learnerState: dueRetest ? "retest" : "independent",
                    requirementStatus,
                  },
                  sourcesAvailable: progress.sourcesAvailable,
                  missingReasons: progress.missingReasons,
                });
                continue;
              }

              warningSet.add("部分课程要求尚无匹配当前版本与身份的作答证据，学习状态已安全置空。");
              resultMap.set(req.id, {
                summary: { learnerState: null, requirementStatus },
                sourcesAvailable: progress?.sourcesAvailable ?? req.sourceRefs.length > 0,
                missingReasons: progress?.missingReasons ?? [],
              });
              continue;
            }

            const timestamps = matchedFeatures.map(feature => Date.parse(feature.attemptedAt));
            if (timestamps.some(ts => !Number.isFinite(ts))) {
              warningSet.add("部分课程要求的作答时间戳不可解析，学习状态已安全置空。");
              resultMap.set(req.id, {
                summary: { learnerState: null, requirementStatus },
                sourcesAvailable: progress?.sourcesAvailable ?? req.sourceRefs.length > 0,
                missingReasons: progress?.missingReasons ?? [],
              });
              continue;
            }

            const latestTime = Math.max(...timestamps);
            const latestFeatures = matchedFeatures.filter(
              feature => Date.parse(feature.attemptedAt) === latestTime,
            );
            if (latestFeatures.length !== 1) {
              warningSet.add("部分课程要求存在同时间戳作答记录（时间顺序歧义），学习状态已安全置空。");
              resultMap.set(req.id, {
                summary: { learnerState: null, requirementStatus },
                sourcesAvailable: progress?.sourcesAvailable ?? req.sourceRefs.length > 0,
                missingReasons: progress?.missingReasons ?? [],
              });
              continue;
            }

            const headFeature = latestFeatures[0]!;
            const projectedObs = localObs.filteredProjected.find(
              obs => obs.id === headFeature.observationId && matchesRequirementIdentity(obs, req),
            );
            const displayReq = learnerState.display.requirements.find(
              item => item.courseId === courseId && item.requirementKey === req.requirementKey,
            );
            const dueRetest = displayReq?.dueRetest ?? false;
            candidateHeads.set(req.id, { feature: headFeature, projectedObs, dueRetest });
            if (headFeature.attemptId) attemptIdsToCheck.add(headFeature.attemptId);
          }

          const solutionRows = attemptIdsToCheck.size
            ? await tx`
                SELECT h.attempt_id, h.support_domain
                FROM opening_help_exposures h
                LEFT JOIN opening_learning_sessions l
                  ON l.id = h.session_id AND l.workspace_id = h.workspace_id
                WHERE h.workspace_id = ${validScope.workspaceId}
                  AND COALESCE(h.owner_user_id, l.owner_user_id) = ${validScope.ownerUserId}
                  AND h.attempt_id = ANY(${[...attemptIdsToCheck]}::uuid[])
                  AND h.kind = 'solution'
                  AND h.level = 'revealed'
                  AND h.delivered = TRUE
              `
            : [];

          for (const req of courseReqs) {
            if (resultMap.has(req.id)) continue;
            const progress = progressByReqId.get(req.id);
            const requirementStatus: AssetGraphRequirementStatus | null = progress?.status ?? null;
            const head = candidateHeads.get(req.id)!;
            const solutionDelivered = Boolean(
              head.feature.attemptId &&
                solutionRows.some(
                  row =>
                    String(row.attempt_id) === head.feature.attemptId &&
                    (String(row.support_domain ?? "unknown") !== "language" ||
                      req.requirementKey.startsWith("language:")),
                ),
            );
            const computedLearnerState = learnerEvidenceDisplayState(
              {
                eligibility: head.feature.eligibility,
                assistance: head.projectedObs?.assistance ?? "unknown",
              },
              { dueRetest: head.dueRetest, solutionDelivered },
            );
            resultMap.set(req.id, {
              summary: { learnerState: computedLearnerState, requirementStatus },
              sourcesAvailable: progress?.sourcesAvailable ?? req.sourceRefs.length > 0,
              missingReasons: progress?.missingReasons ?? [],
            });
          }

          courseSummaryCache.set(courseId, resultMap);
          return resultMap;
        };

        const attachSummaryToNodes = async (nodes: AssetGraphNode[]): Promise<AssetGraphNode[]> => {
          const reqNodes = nodes.filter(node => node.kind === "requirement");
          if (reqNodes.length === 0) return nodes;
          const courseIdsToLoad = new Set<string>();
          for (const node of reqNodes) {
            const parsed = parseAssetGraphNodeId(node.id);
            if (parsed?.kind === "requirement") {
              const req = activeRequirementsById.get(parsed.uuid);
              if (req) courseIdsToLoad.add(req.courseId);
            }
          }
          for (const cid of courseIdsToLoad) {
            await ensureCourseSummaries(cid);
          }
          return nodes.map(node => {
            if (node.kind !== "requirement") return node;
            const parsed = parseAssetGraphNodeId(node.id);
            if (parsed?.kind !== "requirement") return node;
            const req = activeRequirementsById.get(parsed.uuid);
            if (!req) return node;
            const entry = courseSummaryCache.get(req.courseId)?.get(req.id);
            return entry ? { ...node, summary: entry.summary } : node;
          });
        };

        const buildWarnings = () =>
          [...warningSet].map(w => w.trim().slice(0, 500)).filter(Boolean);

        // ============================================================
        // Operation 1: roots
        // ============================================================
        if (query.op === "roots") {
          const anchor = query.cursor
            ? decodeAssetGraphCursor(
                query.cursor,
                {
                  scope: validScope,
                  privacyEpoch,
                  queryDigest,
                  scopeFingerprint,
                  op: "roots",
                },
                secret,
              )
            : null;
          if (anchor && anchor.op !== "roots") {
            throw new OpeningAssetGraphError("CURSOR_STALE", "分页上下文已失效，请从本次查询的第一页重新读取。");
          }

          const allowedKinds = new Set<AssetGraphRootKind>(
            query.kinds ?? ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS[query.lens],
          );
          const needle = query.q?.toLocaleLowerCase() ?? null;

          let candidates = [...visibleNodeMap.values()].filter(node => {
            if (node.kind === "observation") return false;
            if (!allowedKinds.has(node.kind)) return false;
            if (needle !== null && !node.label.toLocaleLowerCase().includes(needle)) return false;
            return true;
          });

          candidates.sort(
            (a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id),
          );

          if (anchor) {
            candidates = candidates.filter(
              node =>
                compareStrings(node.kind, anchor.kind) > 0 ||
                (node.kind === anchor.kind && compareStrings(node.id, anchor.id) > 0),
            );
          }

          const limit = query.limit ?? ASSET_GRAPH_DEFAULT_LIMIT;
          const pageNodes = candidates.slice(0, limit);
          const hasMore = candidates.length > limit;
          const lastNode = pageNodes.at(-1);
          const nextCursor =
            hasMore && lastNode && lastNode.kind !== "observation"
              ? encodeAssetGraphCursor(
                  {
                    v: 1,
                    workspaceId: validScope.workspaceId,
                    ownerUserId: validScope.ownerUserId,
                    privacyEpoch,
                    queryDigest,
                    scopeFingerprint,
                    anchor: { op: "roots", kind: lastNode.kind, id: lastNode.id },
                  },
                  secret,
                )
              : null;

          const includeSummary = Boolean(query.include?.includes("summary"));
          const finalNodes = includeSummary ? await attachSummaryToNodes(pageNodes) : pageNodes;

          return assetGraphPageSchema.parse({
            asOf,
            nodes: finalNodes,
            edges: [],
            page: { nextCursor },
            completeness,
            warnings: buildWarnings(),
            detail: null,
          });
        }

        // ============================================================
        // Operation 2 & 3 shared focus verification
        // ============================================================
        const focusParsed = parseAssetGraphNodeId(query.focus);
        if (!focusParsed) {
          throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
        }

        if (focusParsed.kind === "observation") {
          const header = observationHeaderById.get(focusParsed.uuid);
          if (!header) {
            throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
          }
          if (targetCourseSet.has(header.courseId)) {
            await ensureCourseObservationsLoaded(header.courseId);
          }
          const sharedTargetCoursesForObs = [
            ...new Set(
              visibleSharedLinks
                .filter(link => link.sourceCourseId === header.courseId)
                .map(link => link.targetCourseId),
            ),
          ];
          for (const targetCid of sharedTargetCoursesForObs) {
            await ensureSharedEvidenceLoaded(targetCid);
          }
        }

        const focusNode = visibleNodeMap.get(query.focus);
        if (!focusNode) {
          throw new OpeningAssetGraphError("NOT_FOUND", ASSET_GRAPH_NOT_FOUND_MESSAGE);
        }

        // ============================================================
        // Operation 2: neighbors
        // ============================================================
        if (query.op === "neighbors") {
          const anchor = query.cursor
            ? decodeAssetGraphCursor(
                query.cursor,
                {
                  scope: validScope,
                  privacyEpoch,
                  queryDigest,
                  scopeFingerprint,
                  op: "neighbors",
                },
                secret,
              )
            : null;
          if (anchor && anchor.op !== "neighbors") {
            throw new OpeningAssetGraphError("CURSOR_STALE", "分页上下文已失效，请从本次查询的第一页重新读取。");
          }

          const lensRelations = new Set<AssetGraphRelation>(ASSET_GRAPH_LENS_RELATIONS[query.lens]);
          const allowedRelations = query.relations
            ? new Set(query.relations.filter(rel => lensRelations.has(rel)))
            : lensRelations;

          // Load course observations & shared evidence only when `hasObservation` may be traversed.
          if (
            focusParsed.kind === "requirement" &&
            allowedRelations.has("hasObservation") &&
            query.direction !== "in"
          ) {
            const req = activeRequirementsById.get(focusParsed.uuid);
            if (req) {
              await ensureCourseObservationsLoaded(req.courseId);
              await ensureSharedEvidenceLoaded(req.courseId);
            }
          }

          // Collect all deterministic edges across the 10 relation types, bounded by visibleNodeMap.
          const edgeMap = new Map<string, AssetGraphEdge>();
          const pushEdge = (edge: AssetGraphEdge) => {
            if (!allowedRelations.has(edge.relation)) return;
            if (!visibleNodeMap.has(edge.from) || !visibleNodeMap.has(edge.to)) return;
            if (query.direction === "out" && edge.from !== query.focus) return;
            if (query.direction === "in" && edge.to !== query.focus) return;
            if (query.direction === "both" && edge.from !== query.focus && edge.to !== query.focus) {
              return;
            }
            if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge);
          };

          // 1. servesGoal: course/<cid> -> goal/<gid>
          if (allowedRelations.has("servesGoal")) {
            for (const gid of visibleGoalIds) {
              const goal = visibleGoalsById.get(gid);
              if (!goal) continue;
              const goalNodeId = formatAssetGraphNodeId({ kind: "goal", uuid: gid });
              for (const cid of goal.courseIds) {
                if (!visibleCourseIds.has(cid)) continue;
                const courseNodeId = formatAssetGraphNodeId({ kind: "course", uuid: cid });
                pushEdge({
                  id: `recorded:servesGoal:${courseNodeId}:${goalNodeId}`,
                  from: courseNodeId,
                  to: goalNodeId,
                  relation: "servesGoal",
                  basis: "recorded",
                });
              }
            }
          }

          // 2. scopes: goal/<gid> -> requirement/<rid>
          if (allowedRelations.has("scopes")) {
            for (const gid of visibleGoalIds) {
              const goal = visibleGoalsById.get(gid);
              if (!goal) continue;
              const goalNodeId = formatAssetGraphNodeId({ kind: "goal", uuid: gid });
              for (const cid of goal.courseIds) {
                if (!visibleCourseIds.has(cid)) continue;
                for (const req of activeRequirementsByCourse.get(cid) ?? []) {
                  if (!visibleRequirementIds.has(req.id)) continue;
                  const reqNodeId = formatAssetGraphNodeId({ kind: "requirement", uuid: req.id });
                  if (req.goalIds.includes(gid)) {
                    pushEdge({
                      id: `recorded:scopes:${goalNodeId}:${reqNodeId}`,
                      from: goalNodeId,
                      to: reqNodeId,
                      relation: "scopes",
                      basis: "recorded",
                    });
                  } else if (
                    req.goalIds.length === 0 &&
                    !adaptivePrefsInvalid &&
                    !conflictCourseIds.has(req.courseId)
                  ) {
                    pushEdge({
                      id: `derived:scopes:${goalNodeId}:${reqNodeId}`,
                      from: goalNodeId,
                      to: reqNodeId,
                      relation: "scopes",
                      basis: "derived",
                    });
                  }
                }
              }
            }
          }

          // 3. mappedTo & 4. usesSource
          if (allowedRelations.has("mappedTo") || allowedRelations.has("usesSource")) {
            for (const rid of visibleRequirementIds) {
              const req = activeRequirementsById.get(rid);
              if (!req) continue;
              const reqNodeId = formatAssetGraphNodeId({ kind: "requirement", uuid: rid });
              if (allowedRelations.has("mappedTo") && req.knowledgeNodeId) {
                const knNodeId = formatAssetGraphNodeId({
                  kind: "knowledge",
                  courseId: req.courseId,
                  nodeId: req.knowledgeNodeId,
                });
                pushEdge({
                  id: `recorded:mappedTo:${reqNodeId}:${knNodeId}`,
                  from: reqNodeId,
                  to: knNodeId,
                  relation: "mappedTo",
                  basis: "recorded",
                });
              }
              if (allowedRelations.has("usesSource")) {
                for (const ref of req.sourceRefs) {
                  const srcNodeId = formatAssetGraphNodeId({ kind: "source", uuid: ref.sourceId });
                  const pageSuffix = ref.page ?? 0;
                  pushEdge({
                    id: `recorded:usesSource:${reqNodeId}:${srcNodeId}:v${ref.sourceVersion}:p${pageSuffix}`,
                    from: reqNodeId,
                    to: srcNodeId,
                    relation: "usesSource",
                    basis: "recorded",
                    sourceVersion: ref.sourceVersion,
                    ...(ref.page !== undefined ? { page: ref.page } : {}),
                  });
                }
              }
            }
          }

          // 5. contains / prerequisite / appliesTo
          if (
            allowedRelations.has("contains") ||
            allowedRelations.has("prerequisite") ||
            allowedRelations.has("appliesTo")
          ) {
            const knDedupe = new Map<string, AssetGraphEdge>();
            for (const cid of visibleCourseIds) {
              const knEntry = knowledgeSnapshotsByCourse.get(cid);
              if (!knEntry) continue;
              for (const edge of knEntry.snapshot.edges) {
                const relation: AssetGraphRelation =
                  edge.kind === "applies_to" ? "appliesTo" : edge.kind;
                if (!allowedRelations.has(relation)) continue;
                const fromNodeId = formatAssetGraphNodeId({
                  kind: "knowledge",
                  courseId: cid,
                  nodeId: edge.from,
                });
                const toNodeId = formatAssetGraphNodeId({
                  kind: "knowledge",
                  courseId: cid,
                  nodeId: edge.to,
                });
                if (!visibleNodeMap.has(fromNodeId) || !visibleNodeMap.has(toNodeId)) continue;
                const basis = edge.status === "suggested" ? "suggested" : "recorded";
                const dedupeKey = `${relation}:${fromNodeId}:${toNodeId}`;
                const existing = knDedupe.get(dedupeKey);
                if (!existing || (existing.basis === "suggested" && basis === "recorded")) {
                  knDedupe.set(dedupeKey, {
                    id: `${basis}:${relation}:${fromNodeId}:${toNodeId}`,
                    from: fromNodeId,
                    to: toNodeId,
                    relation,
                    basis,
                  });
                }
              }
            }
            for (const edge of knDedupe.values()) pushEdge(edge);
          }

          // 6. hasObservation: requirement/<rid> -> observation/<oid>
          if (allowedRelations.has("hasObservation")) {
            for (const [obsNodeId, entry] of visibleObservationsByNodeId) {
              for (const rid of entry.matchedRequirementIds) {
                const reqNodeId = formatAssetGraphNodeId({ kind: "requirement", uuid: rid });
                pushEdge({
                  id: `recorded:hasObservation:${reqNodeId}:${obsNodeId}`,
                  from: reqNodeId,
                  to: obsNodeId,
                  relation: "hasObservation",
                  basis: "recorded",
                });
              }
              for (const [targetReqId, attrs] of entry.sharedAttributionsByTargetReqId) {
                const targetReqNodeId = formatAssetGraphNodeId({
                  kind: "requirement",
                  uuid: targetReqId,
                });
                for (const attr of attrs) {
                  pushEdge({
                    id: `derived:hasObservation:${targetReqNodeId}:${obsNodeId}:link:${attr.linkId}`,
                    from: targetReqNodeId,
                    to: obsNodeId,
                    relation: "hasObservation",
                    basis: "derived",
                    sharedAttribution: attr,
                  });
                }
              }
            }
          }

          // 7. linkedTo: document/<did> | source/<sid> -> requirement/<rid> | goal/<gid> | course/<cid>
          if (allowedRelations.has("linkedTo")) {
            for (const link of assetLinks) {
              const fromNodeId = formatAssetGraphNodeId({
                kind: link.assetType,
                uuid: link.assetId,
              });
              const toNodeId = resolveAssetLinkTargetNodeId(link);
              if (!toNodeId) continue;
              pushEdge({
                id: `recorded:linkedTo:${fromNodeId}:${toNodeId}`,
                from: fromNodeId,
                to: toNodeId,
                relation: "linkedTo",
                basis: "recorded",
              });
            }
          }

          // 8. promotedTo: exploration/<eid> -> document/<did>
          if (allowedRelations.has("promotedTo")) {
            for (const promo of promotions) {
              const fromNodeId = formatAssetGraphNodeId({
                kind: "exploration",
                uuid: promo.explorationId,
              });
              const toNodeId = formatAssetGraphNodeId({
                kind: "document",
                uuid: promo.targetId,
              });
              pushEdge({
                id: `recorded:promotedTo:${fromNodeId}:${toNodeId}`,
                from: fromNodeId,
                to: toNodeId,
                relation: "promotedTo",
                basis: "recorded",
              });
            }
          }

          let edges = [...edgeMap.values()].sort(
            (a, b) => compareStrings(a.relation, b.relation) || compareStrings(a.id, b.id),
          );

          if (anchor) {
            edges = edges.filter(
              edge =>
                compareStrings(edge.relation, anchor.relation) > 0 ||
                (edge.relation === anchor.relation && compareStrings(edge.id, anchor.edgeId) > 0),
            );
          }

          const limit = query.limit ?? ASSET_GRAPH_DEFAULT_LIMIT;
          const pageEdges = edges.slice(0, limit);
          const hasMore = edges.length > limit;
          const lastEdge = pageEdges.at(-1);
          const nextCursor =
            hasMore && lastEdge
              ? encodeAssetGraphCursor(
                  {
                    v: 1,
                    workspaceId: validScope.workspaceId,
                    ownerUserId: validScope.ownerUserId,
                    privacyEpoch,
                    queryDigest,
                    scopeFingerprint,
                    anchor: {
                      op: "neighbors",
                      relation: lastEdge.relation,
                      edgeId: lastEdge.id,
                    },
                  },
                  secret,
                )
              : null;

          const pageNodeMap = new Map<string, AssetGraphNode>([[focusNode.id, focusNode]]);
          for (const edge of pageEdges) {
            const fromNode = visibleNodeMap.get(edge.from);
            const toNode = visibleNodeMap.get(edge.to);
            if (fromNode) pageNodeMap.set(fromNode.id, fromNode);
            if (toNode) pageNodeMap.set(toNode.id, toNode);
          }

          const sortedNodes = [...pageNodeMap.values()].sort(
            (a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id),
          );
          const includeSummary = Boolean(query.include?.includes("summary"));
          const finalNodes = includeSummary ? await attachSummaryToNodes(sortedNodes) : sortedNodes;

          return assetGraphPageSchema.parse({
            asOf,
            nodes: finalNodes,
            edges: pageEdges,
            page: { nextCursor },
            completeness,
            warnings: buildWarnings(),
            detail: null,
          });
        }

        // ============================================================
        // Operation 3: detail
        // ============================================================
        let learnerState: AssetGraphLearnerState | null = null;
        let requirementStatus: AssetGraphRequirementStatus | null = null;
        const notes: string[] = [];
        const actions: AssetGraphAction[] = [];

        if (focusParsed.kind === "requirement") {
          const req = activeRequirementsById.get(focusParsed.uuid)!;
          const summaries = await ensureCourseSummaries(req.courseId);
          const summaryEntry = summaries.get(req.id);
          const sharedAttrs = sharedAttributionsByReqId.get(req.id) ?? [];
          learnerState = summaryEntry?.summary.learnerState ?? null;
          requirementStatus = summaryEntry?.summary.requirementStatus ?? null;

          notes.push(
            req.approvedAt !== null
              ? "该课程要求已确认生效。"
              : "该课程要求尚未确认，暂不能直接发起路线学习。",
          );
          if (requirementStatus !== null) {
            notes.push(
              sharedAttrs.length > 0
                ? `当前路线状态为“${REQUIREMENT_STATUS_LABELS[requirementStatus]}”（基于当前有效要求、本地合格作答与跨课共享有效证据投影）。`
                : `当前路线状态为“${REQUIREMENT_STATUS_LABELS[requirementStatus]}”（基于当前有效要求与本地合格作答投影）。`,
            );
          }
          for (const attr of sharedAttrs) {
            if (notes.length >= 20) break;
            notes.push(
              `已关联跨课共享有效证据：来自「${attr.sourceCourseTitle} · ${attr.sourceRequirementTitle}」（第 ${attr.sourceRequirementRevision} 版）。`.slice(
                0,
                500,
              ),
            );
          }
          if (learnerState !== null) {
            notes.push(`当前学习者证据状态为“${LEARNER_STATE_LABELS[learnerState]}”。`);
          } else {
            notes.push("当前尚无匹配本要求版本的学习者状态摘要。");
          }
          if (summaryEntry && !summaryEntry.sourcesAvailable) {
            notes.push("所引用的学习材料存在缺失、不可用或版本变化。");
          } else if (req.sourceRefs.length === 0) {
            notes.push("该课程要求尚未绑定参考材料。");
          } else {
            notes.push("所引用的学习材料当前版本可用。");
          }
          for (const reason of summaryEntry?.missingReasons ?? []) {
            const cleaned = reason.trim().slice(0, 400);
            if (cleaned && !notes.includes(cleaned) && notes.length < 20) {
              notes.push(cleaned);
            }
          }

          let candidateGoal: LearningGoal | undefined;
          if (contextGoalId !== null) {
            candidateGoal = visibleGoalsById.get(contextGoalId);
          } else if (!adaptivePrefsInvalid && !conflictCourseIds.has(req.courseId)) {
            const selectedGoalId = courseGoalRefs[req.courseId];
            if (selectedGoalId) candidateGoal = visibleGoalsById.get(selectedGoalId);
          }

          const goalEligible =
            candidateGoal !== undefined &&
            candidateGoal.courseIds.includes(req.courseId) &&
            candidateGoal.lifecycle !== "stopped" &&
            candidateGoal.lifecycle !== "archived" &&
            ["active", "maintenance", "reduced"].includes(candidateGoal.lifecycle) &&
            (req.goalIds.length === 0 || req.goalIds.includes(candidateGoal.id));

          if (req.approvedAt !== null && goalEligible && candidateGoal) {
            actions.push({
              kind: "startCourseRequirement",
              courseId: req.courseId,
              goalId: candidateGoal.id,
              requirementId: req.id,
              expectedGoalRevision: candidateGoal.revision,
              expectedRequirementRevision: req.revision,
              label: "开始学习此要求",
            });
          } else if (req.approvedAt !== null && candidateGoal && !goalEligible && notes.length < 20) {
            notes.push("关联目标当前处于暂停或停止状态，或未覆盖此要求，无法直接从此发起学习。");
          } else if (req.approvedAt !== null && !candidateGoal && notes.length < 20) {
            notes.push("所属课程尚未确定唯一已选活跃目标，请在课程页选择目标后开始学习。");
          }

          actions.push({
            kind: "navigate",
            href: `/opening/courses/${req.courseId}`,
            label: "查看课程路线",
          });
        } else if (focusParsed.kind === "course") {
          notes.push("该课程处于活跃状态，可在课程页管理目标、要求范围与关联材料。");
          actions.push({
            kind: "navigate",
            href: `/opening/courses/${focusParsed.uuid}`,
            label: "查看课程",
          });
        } else if (focusParsed.kind === "goal") {
          const goal = visibleGoalsById.get(focusParsed.uuid)!;
          const activeGoalCourseIds = goal.courseIds.filter(cid => activeCourses.has(cid));
          notes.push(
            `目标状态：${GOAL_LIFECYCLE_LABELS[goal.lifecycle]}（第 ${goal.revision} 版），关联 ${activeGoalCourseIds.length} 门活跃课程。`,
          );
          if (activeGoalCourseIds.some(cid => conflictCourseIds.has(cid))) {
            notes.push("所属课程存在旧目标冲突，未指定目标的课程要求默认适用范围暂不确定。");
          }
          if (activeGoalCourseIds.length > 0) {
            actions.push({
              kind: "navigate",
              href: `/opening/courses/${activeGoalCourseIds[0]}#course-goals`,
              label: "查看课程目标",
            });
          }
        } else if (focusParsed.kind === "knowledge") {
          const knStatus = focusNode.meta?.knowledgeStatus;
          notes.push(
            knStatus
              ? `知识节点状态：${KNOWLEDGE_STATUS_LABELS[knStatus]}。`
              : "课程知识图谱节点。",
          );
          actions.push({
            kind: "navigate",
            href: `/opening/courses/${focusParsed.courseId}`,
            label: "查看所属课程",
          });
        } else if (focusParsed.kind === "source") {
          const src = workspaceSources.get(focusParsed.uuid)!;
          notes.push(`当前可用材料版本：v${src.version}。`);
          if (src.aiExcluded) {
            notes.push("该资料已设为不供 AI 使用，个人查阅与资产关联仍保留。");
          } else {
            notes.push("该资料可用于个人查阅与课程关联。");
          }
          actions.push({
            kind: "navigate",
            href: `/opening/library?tab=materials&source=${src.id}&version=${src.version}`,
            label: "查看原资料",
          });
        } else if (focusParsed.kind === "document") {
          const doc = workspaceDocuments.get(focusParsed.uuid)!;
          notes.push(`笔记生命周期：${doc.lifecycle}，当前修订第 ${doc.currentRevisionNumber} 版。`);
          actions.push({
            kind: "navigate",
            href: `/opening/library/${doc.id}`,
            label: "查看笔记",
          });
        } else if (focusParsed.kind === "exploration") {
          const exp = workspaceExplorations.get(focusParsed.uuid)!;
          notes.push(`自由探索状态：${exp.status === "closed" ? "已结束" : "进行中"}。`);
        } else if (focusParsed.kind === "observation") {
          const obsEntry = visibleObservationsByNodeId.get(focusNode.id)!;
          const occurredAt = focusNode.meta?.occurredAt ?? asOf;
          const sharedTargetEntries = [...obsEntry.sharedAttributionsByTargetReqId.entries()];
          const isCrossCourseOrigin =
            (contextCourseId !== null && obsEntry.courseId !== contextCourseId) ||
            sharedTargetEntries.length > 0;
          const sourceCourseTitle = activeCourses.get(obsEntry.courseId)?.title ?? "来源课程";

          notes.push(`作答形式：${focusNode.label}，记录时间：${occurredAt}。`);
          if (isCrossCourseOrigin) {
            notes.push(
              `来源课程：「${sourceCourseTitle}」，此为安全脱敏后的跨课共享有效证据摘要，不包含题干、作答原文或参考答案。`.slice(
                0,
                500,
              ),
            );
            const seenLinks = new Set<string>();
            for (const [targetReqId, attrs] of sharedTargetEntries) {
              const targetReqTitle = activeRequirementsById.get(targetReqId)?.title;
              for (const attr of attrs) {
                if (seenLinks.has(attr.linkId) || notes.length >= 20) continue;
                seenLinks.add(attr.linkId);
                notes.push(
                  `跨课共享自「${attr.sourceCourseTitle} · ${attr.sourceRequirementTitle}」（第 ${attr.sourceRequirementRevision} 版）${targetReqTitle ? `，用于「${targetReqTitle}」` : ""}。`.slice(
                    0,
                    500,
                  ),
                );
              }
            }
          } else {
            notes.push("此为安全脱敏后的本地有效作答摘要，不包含题干、作答原文或参考答案。");
          }
          actions.push({
            kind: "navigate",
            href: `/opening/courses/${obsEntry.courseId}`,
            label: isCrossCourseOrigin ? "查看来源课程" : "查看所属课程",
          });
        }

        return assetGraphPageSchema.parse({
          asOf,
          nodes: [focusNode],
          edges: [],
          page: { nextCursor: null },
          completeness,
          warnings: buildWarnings(),
          detail: {
            id: focusNode.id,
            learnerState,
            requirementStatus,
            notes: notes.slice(0, 20),
            actions: actions.slice(0, 10),
          },
        });
      }) as Promise<AssetGraphPage>;
    },
  };
}
