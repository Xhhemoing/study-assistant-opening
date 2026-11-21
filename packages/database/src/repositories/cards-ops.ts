import { cardReadable } from "./card-sources";
import {
  examPaperInputSchema,
  reviewQueueModeSchema,
  type ExamPack,
  type ExamPaper,
  type ReviewQueueMode,
  type ReviewState,
} from "@aistudy/contracts";
import {
  buildReviewQueue,
  forecastExamTopics,
  localDateKeyInZone,
  resolveWorkspaceTimeZone,
  type ReviewQueueItem,
} from "@aistudy/domain";
import type { Sql } from "postgres";
import {
  CardRepositoryError,
  mapCard,
  mapState,
  type CardQueueEntry,
  type CardRecord,
  type CardStateRecord,
  type Row,
} from "./cards-types";
import { openingCurrentKnowledgeNodesQuery, parseExamBinding } from "./opening-exam-skill-identity";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import type { LearningSql } from "./opening-learning-facts";

function normalizeSkillLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function extractMemberCourseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
  }
  return ids;
}

function parseExamPaperRow(row: Row): ExamPaper | null {
  if (
    typeof row.id !== "string"
    || typeof row.sprint_id !== "string"
    || typeof row.course_id !== "string"
    || row.kind !== "past_exam"
    || row.binding == null
    || !Array.isArray(row.skills)
  ) {
    return null;
  }
  const parsed = examPaperInputSchema.safeParse({
    clientKey: typeof row.client_key === "string" && row.client_key.length >= 8
      ? row.client_key
      : `exam-paper-${row.id}`,
    sourceId: row.source_id,
    sourceVersion: Number(row.source_version),
    teacher: row.teacher,
    year: Number(row.year),
    label: row.label,
    kind: row.kind,
    skills: row.skills,
  });
  if (!parsed.success) return null;
  const { clientKey: _clientKey, ...paper } = parsed.data;
  const recordedAt = row.recorded_at instanceof Date || typeof row.recorded_at === "string"
    ? new Date(row.recorded_at).toISOString()
    : new Date(0).toISOString();
  return {
    ...paper,
    id: row.id,
    courseId: row.course_id,
    recordedAt,
  };
}

type BoundExamSkillWeight = {
  skillId: string;
  nodeId: string;
  requirementKey: string;
  meanPoints: number;
  packLabels: ReadonlySet<string>;
};

type ActiveRequirementMatch = {
  requirementKey: string;
  knowledgeNodeId: string | null;
};

function buildPackLabelsBySkillId(pack: ExamPack): Map<string, Set<string>> {
  const topicsById = new Map(pack.topics.map((topic) => [topic.id, normalizeSkillLabel(topic.title)]));
  const lessonsById = new Map(pack.lessons.map((lesson) => [lesson.id, normalizeSkillLabel(lesson.title)]));
  const labelsBySkill = new Map<string, Set<string>>();
  for (const question of pack.questions) {
    let set = labelsBySkill.get(question.skillId);
    if (!set) {
      set = new Set<string>();
      labelsBySkill.set(question.skillId, set);
    }
    const lessonTitle = lessonsById.get(question.lessonId);
    if (lessonTitle) set.add(lessonTitle);
    const topicTitle = topicsById.get(question.topicId);
    if (topicTitle) set.add(topicTitle);
  }
  return labelsBySkill;
}

async function loadBoundExamSkillWeights(
  sql: Sql,
  scope: { workspaceId: string; ownerUserId: string },
  candidateCourseIds: readonly string[],
  needsSkillLabelLookup: boolean,
): Promise<{
  skillsByCourse: Map<string, BoundExamSkillWeight[]>;
  requirementsByCourseLabel: Map<string, Map<string, ActiveRequirementMatch[]>>;
  archivedRequirementKeysByCourse: Map<string, Set<string>>;
}> {
  const skillsByCourse = new Map<string, BoundExamSkillWeight[]>();
  const requirementsByCourseLabel = new Map<string, Map<string, ActiveRequirementMatch[]>>();
  const archivedRequirementKeysByCourse = new Map<string, Set<string>>();
  if (!candidateCourseIds.length) {
    return { skillsByCourse, requirementsByCourseLabel, archivedRequirementKeysByCourse };
  }

  const rawPaperRows = await sql`
    SELECT
      p.id,
      p.sprint_id,
      p.course_id,
      p.source_id,
      p.source_version,
      p.teacher,
      p.year,
      p.label,
      p.kind,
      p.skills,
      p.client_key,
      p.recorded_at,
      b.binding,
      sprint.pack_snapshot,
      sprint.state AS sprint_state
    FROM opening_exam_papers p
    JOIN opening_exam_sprints sprint
      ON sprint.id = p.sprint_id
     AND sprint.workspace_id = p.workspace_id
     AND sprint.owner_user_id = p.owner_user_id
    JOIN opening_exam_bindings b
      ON b.sprint_id = p.sprint_id
     AND b.course_id = p.course_id
    JOIN courses course
      ON course.id = p.course_id
     AND course.workspace_id = p.workspace_id
     AND course.archived_at IS NULL
    JOIN course_asset_memberships m
      ON m.course_id = p.course_id
     AND m.workspace_id = p.workspace_id
     AND m.asset_type = 'source'
     AND m.asset_id = p.source_id
    JOIN opening_sources s
      ON s.id = p.source_id
     AND s.workspace_id = p.workspace_id
     AND s.version = p.source_version
    JOIN opening_source_versions v
      ON v.source_id = s.id
     AND v.workspace_id = s.workspace_id
     AND v.version = p.source_version
    WHERE p.workspace_id = ${scope.workspaceId}
      AND p.owner_user_id = ${scope.ownerUserId}
      AND p.course_id = ANY(${[...candidateCourseIds]}::uuid[])
      AND p.kind = 'past_exam'
      AND s.upload_state = 'uploaded'
      AND s.parse_state = 'ready'
      AND v.availability = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
      )
      AND EXISTS (
        SELECT 1 FROM opening_source_chunks sc
        WHERE sc.source_id = s.id
          AND sc.source_version = p.source_version
          AND (sc.text ~ '[^[:space:]]' OR (sc.image_object_key IS NOT NULL AND sc.image_object_key <> ''))
      )
    ORDER BY p.recorded_at ASC, p.id ASC
  `;

  type SprintBucket = {
    courseId: string;
    bindingRaw: unknown;
    packSnapshot: unknown;
    sprintState: unknown;
    papers: ExamPaper[];
  };
  const sprints = new Map<string, SprintBucket>();
  for (const entry of rawPaperRows) {
    const raw = entry as Row;
    const paper = parseExamPaperRow(raw);
    if (!paper) continue;
    const sprintId = String(raw.sprint_id);
    const existing = sprints.get(sprintId);
    if (existing) {
      existing.papers.push(paper);
    } else {
      sprints.set(sprintId, {
        courseId: paper.courseId,
        bindingRaw: raw.binding,
        packSnapshot: raw.pack_snapshot,
        sprintState: raw.sprint_state,
        papers: [paper],
      });
    }
  }
  if (!sprints.size) {
    return { skillsByCourse, requirementsByCourseLabel, archivedRequirementKeysByCourse };
  }

  const nodeRows = await openingCurrentKnowledgeNodesQuery(sql as unknown as LearningSql, scope);
  const supportedNodesByCourse = new Map<string, Set<string>>();
  for (const row of nodeRows) {
    const raw = row as Row;
    if (typeof raw.course_id !== "string" || typeof raw.node_id !== "string") continue;
    let nodes = supportedNodesByCourse.get(raw.course_id);
    if (!nodes) {
      nodes = new Set<string>();
      supportedNodesByCourse.set(raw.course_id, nodes);
    }
    nodes.add(raw.node_id);
  }

  const paperCourseIds = [...new Set([...sprints.values()].map((bucket) => bucket.courseId))];
  if (needsSkillLabelLookup && paperCourseIds.length) {
    const reqRows = await sql`
      SELECT course_id, requirement_key, title, knowledge_node_id, lifecycle
      FROM course_requirements
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND course_id = ANY(${paperCourseIds}::uuid[])
    `;
    for (const row of reqRows) {
      const raw = row as Row;
      if (typeof raw.course_id !== "string" || typeof raw.requirement_key !== "string") continue;
      const lifecycle = typeof raw.lifecycle === "string" ? raw.lifecycle : "active";
      if (lifecycle === "archived") {
        let archivedKeys = archivedRequirementKeysByCourse.get(raw.course_id);
        if (!archivedKeys) {
          archivedKeys = new Set<string>();
          archivedRequirementKeysByCourse.set(raw.course_id, archivedKeys);
        }
        archivedKeys.add(raw.requirement_key);
        continue;
      }
      if (lifecycle !== "active") continue;
      let byLabel = requirementsByCourseLabel.get(raw.course_id);
      if (!byLabel) {
        byLabel = new Map<string, ActiveRequirementMatch[]>();
        requirementsByCourseLabel.set(raw.course_id, byLabel);
      }
      const match: ActiveRequirementMatch = {
        requirementKey: raw.requirement_key,
        knowledgeNodeId: typeof raw.knowledge_node_id === "string" ? raw.knowledge_node_id : null,
      };
      for (const label of new Set([normalizeSkillLabel(raw.title), normalizeSkillLabel(raw.requirement_key)])) {
        if (!label) continue;
        const list = byLabel.get(label);
        if (list) list.push(match);
        else byLabel.set(label, [match]);
      }
    }
  }

  for (const bucket of sprints.values()) {
    const binding = parseExamBinding(bucket.bindingRaw);
    if (binding.courseId !== bucket.courseId) continue;
    const supportedNodes = supportedNodesByCourse.get(bucket.courseId);
    if (!supportedNodes?.size) continue;

    let skillIds: string[];
    let packLabelsBySkillId = new Map<string, Set<string>>();
    if (bucket.packSnapshot != null && bucket.sprintState != null) {
      const { pack } = parseExamSprintSnapshot(bucket.packSnapshot, bucket.sprintState);
      skillIds = [...new Set(pack.questions.map((question) => question.skillId))];
      packLabelsBySkillId = buildPackLabelsBySkillId(pack);
    } else {
      skillIds = [...new Set(binding.skills.map((skill) => skill.skillId))];
    }

    const teachers = [...new Set(bucket.papers.map((paper) => paper.teacher))];
    const meanPointsBySkillId = new Map<string, number>();
    for (const teacher of teachers) {
      const forecast = forecastExamTopics(bucket.papers, skillIds, teacher);
      for (const topic of forecast.topics) {
        if (typeof topic.meanPoints !== "number" || !Number.isFinite(topic.meanPoints)) continue;
        const previous = meanPointsBySkillId.get(topic.skillId);
        meanPointsBySkillId.set(
          topic.skillId,
          previous === undefined ? topic.meanPoints : Math.max(previous, topic.meanPoints),
        );
      }
    }

    let courseSkills = skillsByCourse.get(bucket.courseId);
    if (!courseSkills) {
      courseSkills = [];
      skillsByCourse.set(bucket.courseId, courseSkills);
    }
    for (const skill of binding.skills) {
      if (!supportedNodes.has(skill.nodeId)) continue;
      const meanPoints = meanPointsBySkillId.get(skill.skillId);
      if (meanPoints === undefined) continue;
      courseSkills.push({
        skillId: skill.skillId,
        nodeId: skill.nodeId,
        requirementKey: skill.requirementKey,
        meanPoints,
        packLabels: packLabelsBySkillId.get(skill.skillId) ?? new Set<string>(),
      });
    }
  }

  return { skillsByCourse, requirementsByCourseLabel, archivedRequirementKeysByCourse };
}

function resolveCardHistoricalMeanPoints(
  card: CardRecord,
  memberCourseIds: readonly string[],
  lookup: {
    skillsByCourse: Map<string, BoundExamSkillWeight[]>;
    requirementsByCourseLabel: Map<string, Map<string, ActiveRequirementMatch[]>>;
    archivedRequirementKeysByCourse: Map<string, Set<string>>;
  },
): number | undefined {
  if (!lookup.skillsByCourse.size) return undefined;
  const candidateCourses = new Set<string>();
  if (card.courseId) candidateCourses.add(card.courseId);
  for (const id of memberCourseIds) candidateCourses.add(id);
  if (!candidateCourses.size) return undefined;

  const syllabusPointId = card.syllabusPointId?.trim() || null;
  const normalizedLabel = normalizeSkillLabel(card.skillLabel);
  let bestMeanPoints: number | undefined;

  const consider = (points: number) => {
    bestMeanPoints = bestMeanPoints === undefined ? points : Math.max(bestMeanPoints, points);
  };

  for (const courseId of candidateCourses) {
    const boundSkills = lookup.skillsByCourse.get(courseId);
    if (!boundSkills?.length) continue;

    if (syllabusPointId !== null) {
      // Explicit syllabusPointId binds strictly by nodeId and never cross-matches via skillLabel.
      for (const skill of boundSkills) {
        if (skill.nodeId === syllabusPointId) consider(skill.meanPoints);
      }
      continue;
    }

    if (!normalizedLabel) continue;
    const reqMatches = lookup.requirementsByCourseLabel.get(courseId)?.get(normalizedLabel) ?? [];
    const archivedReqKeys = lookup.archivedRequirementKeysByCourse.get(courseId);
    let matchedDirect = false;
    for (const skill of boundSkills) {
      // Requirement keys match exclusively via active `course_requirements`, never directly
      // on `binding.skills`, so archived requirements cannot be revived by label lookup.
      const matchesActiveRequirement = reqMatches.some(
        (req) => req.requirementKey === skill.requirementKey
          || (req.knowledgeNodeId !== null && req.knowledgeNodeId === skill.nodeId),
      );
      if (matchesActiveRequirement) {
        matchedDirect = true;
        consider(skill.meanPoints);
        continue;
      }
      if (archivedReqKeys?.has(skill.requirementKey)) continue;
      if (normalizeSkillLabel(skill.skillId) === normalizedLabel) {
        matchedDirect = true;
        consider(skill.meanPoints);
      }
    }
    if (!matchedDirect) {
      for (const skill of boundSkills) {
        if (archivedReqKeys?.has(skill.requirementKey)) continue;
        if (skill.packLabels.has(normalizedLabel)) consider(skill.meanPoints);
      }
    }
  }

  return bestMeanPoints;
}

export async function assertWorkspaceOwner(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<void> {
  const rows = await client<{ owner_user_id: string }[]>`
    SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
  if (rows[0]!.owner_user_id !== ownerUserId) {
    throw new CardRepositoryError(
      "WORKSPACE_MISMATCH",
      "Card owner must match workspace owner",
    );
  }
}

export async function lockCardForUpdate(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  cardId: string,
): Promise<void> {
  const rows = await client`
    SELECT id FROM cards
    WHERE workspace_id = ${workspaceId}
      AND owner_user_id = ${ownerUserId}
      AND id = ${cardId}
    FOR UPDATE
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Card not found: ${cardId}`);
  }
}

export async function loadReviewStateForUpdate(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  cardId: string,
): Promise<CardStateRecord | null> {
  const rows = await client`
    SELECT * FROM card_review_states
    WHERE workspace_id = ${workspaceId}
      AND owner_user_id = ${ownerUserId}
      AND card_id = ${cardId}
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ? mapState(rows[0] as Row) : null;
}

export async function loadCard(
  client: Sql,
  workspaceId: string,
  cardId: string,
): Promise<CardRecord> {
  const rows = await client`
    SELECT c.* FROM cards c WHERE c.id = ${cardId} AND c.workspace_id = ${workspaceId}
      AND ${cardReadable(client, workspaceId)} LIMIT 1
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Card not found: ${cardId}`);
  }
  return mapCard(rows[0] as Row);
}

export async function writeState(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  state: ReviewState,
): Promise<CardStateRecord> {
  const rows = await client`
    INSERT INTO card_review_states (
      owner_user_id, card_id, workspace_id, ease, interval_days, due_at,
      reps, lapses, last_grade, updated_at, srs_version, fsrs_state
    ) VALUES (
      ${ownerUserId}, ${state.cardId}, ${workspaceId}, ${state.ease},
      ${state.intervalDays}, ${state.dueAt}, ${state.reps}, ${state.lapses},
      ${state.lastGrade}, ${state.updatedAt}, ${state.srsVersion ?? "srs-1"}, ${state.fsrs ? client.json(state.fsrs) : null}
    )
    ON CONFLICT (owner_user_id, card_id) DO UPDATE SET
      srs_version = EXCLUDED.srs_version,
      fsrs_state = EXCLUDED.fsrs_state,
      ease = EXCLUDED.ease,
      interval_days = EXCLUDED.interval_days,
      due_at = EXCLUDED.due_at,
      reps = EXCLUDED.reps,
      lapses = EXCLUDED.lapses,
      last_grade = EXCLUDED.last_grade,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  return mapState(rows[0] as Row);
}

export async function listWorkspaceCards(
  sql: Sql,
  input: { workspaceId: string; ownerUserId: string },
): Promise<CardRecord[]> {
  await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
  const rows = await sql`
    SELECT c.* FROM cards c
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.owner_user_id = ${input.ownerUserId}
      AND ${cardReadable(sql, input.workspaceId)}
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => mapCard(row as Row));
}

export async function listCardQueue(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    mode: ReviewQueueMode;
    now?: Date;
    today?: string;
    /**
     * Workspace business IANA zone (planning_settings.timeZone). Missing/blank →
     * DEFAULT_WORKSPACE_TIME_ZONE (Asia/Shanghai). Invalid zone → RangeError
     * (explicit failure, never a silent UTC fallback).
     */
    timeZone?: string | null;
    /** Optional session card cap applied strictly after global 5-band triage. */
    maxSessionCards?: number;
  },
): Promise<CardQueueEntry[]> {
  const mode = reviewQueueModeSchema.parse(input.mode);
  const now = input.now ?? new Date();
  // Local business day of `now` in the workspace zone — NOT the UTC date (TZ01).
  const today = input.today ?? localDateKeyInZone(now, resolveWorkspaceTimeZone(input.timeZone));
  // Pure read across all eligible cards (no pre-triage SQL LIMIT and zero writes to cards/review_states/events).
  const rows = await sql`
    SELECT c.*, s.srs_version, s.fsrs_state, s.ease, s.interval_days, s.due_at, s.reps, s.lapses, s.last_grade,
      s.updated_at AS state_updated_at, s.owner_user_id AS state_owner_user_id,
      COALESCE(MAX(g.priority), 0)::int AS goal_priority,
      COALESCE(array_agg(DISTINCT m.course_id) FILTER (WHERE m.course_id IS NOT NULL), '{}'::uuid[]) AS member_course_ids,
      EXISTS (
        SELECT 1 FROM opening_retest_activities r
        WHERE r.workspace_id = c.workspace_id
          AND r.owner_user_id = ${input.ownerUserId}
          AND r.status IN ('accepted', 'in_progress')
          AND (
            r.course_id = c.course_id
            OR (
              c.course_id IS NULL
              AND EXISTS (
                SELECT 1 FROM course_asset_memberships m2
                WHERE m2.workspace_id = c.workspace_id
                  AND m2.asset_type = 'card'
                  AND m2.asset_id = c.id
                  AND m2.course_id = r.course_id
              )
            )
          )
          AND (
            (
              c.syllabus_point_id IS NOT NULL
              AND r.requirement_key IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM course_requirements cr
                WHERE cr.workspace_id = c.workspace_id
                  AND cr.owner_user_id = ${input.ownerUserId}
                  AND cr.course_id = r.course_id
                  AND cr.requirement_key = r.requirement_key
                  AND cr.lifecycle = 'active'
                  AND cr.knowledge_node_id = c.syllabus_point_id
              )
            )
            OR (
              c.syllabus_point_id IS NULL
              AND c.skill_label IS NOT NULL
              AND btrim(c.skill_label) <> ''
              AND lower(btrim(r.skill_label)) = lower(btrim(c.skill_label))
              AND NOT EXISTS (
                SELECT 1
                FROM course_requirements cr1
                JOIN course_requirements cr2
                  ON cr2.workspace_id = cr1.workspace_id
                 AND cr2.owner_user_id = cr1.owner_user_id
                 AND cr2.course_id = cr1.course_id
                 AND cr2.lifecycle = 'active'
                WHERE cr1.workspace_id = c.workspace_id
                  AND cr1.owner_user_id = ${input.ownerUserId}
                  AND cr1.course_id = r.course_id
                  AND cr1.lifecycle = 'active'
                  AND cr1.knowledge_node_id IS NOT NULL
                  AND cr2.knowledge_node_id IS NOT NULL
                  AND cr1.knowledge_node_id <> cr2.knowledge_node_id
                  AND (
                    lower(btrim(cr1.title)) = lower(btrim(c.skill_label))
                    OR lower(btrim(cr1.requirement_key)) = lower(btrim(c.skill_label))
                  )
                  AND (
                    lower(btrim(cr2.title)) = lower(btrim(c.skill_label))
                    OR lower(btrim(cr2.requirement_key)) = lower(btrim(c.skill_label))
                  )
              )
              AND (
                r.requirement_key IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM course_requirements cr
                  WHERE cr.workspace_id = c.workspace_id
                    AND cr.owner_user_id = ${input.ownerUserId}
                    AND cr.course_id = r.course_id
                    AND cr.requirement_key = r.requirement_key
                    AND cr.lifecycle = 'active'
                    AND cr.knowledge_node_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM course_requirements cr2
                      WHERE cr2.workspace_id = c.workspace_id
                        AND cr2.owner_user_id = ${input.ownerUserId}
                        AND cr2.course_id = r.course_id
                        AND cr2.lifecycle = 'active'
                        AND lower(btrim(cr2.title)) = lower(btrim(c.skill_label))
                        AND cr2.knowledge_node_id IS DISTINCT FROM cr.knowledge_node_id
                    )
                )
              )
            )
          )
      ) AS delayed_check_covered
    FROM cards c
    INNER JOIN card_review_states s
      ON s.card_id = c.id
     AND s.workspace_id = c.workspace_id
     AND s.owner_user_id = ${input.ownerUserId}
    LEFT JOIN course_asset_memberships m
      ON m.asset_type = 'card' AND m.asset_id = c.id AND m.workspace_id = c.workspace_id
    LEFT JOIN course_goals g
      ON (g.course_id IN (m.course_id,c.course_id) OR EXISTS (SELECT 1 FROM course_goal_links gl WHERE gl.workspace_id=g.workspace_id AND gl.goal_id=g.id AND gl.course_id IN (m.course_id,c.course_id))) AND g.workspace_id = c.workspace_id
     AND g.active = true AND g.archived_at IS NULL
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.auto_paused = false
      AND ${cardReadable(sql, input.workspaceId)}
    GROUP BY c.id, s.owner_user_id, s.card_id, s.workspace_id, s.srs_version, s.fsrs_state, s.ease, s.interval_days,
      s.due_at, s.reps, s.lapses, s.last_grade, s.updated_at
  `;

  const mappedRows = rows.map((row) => {
    const raw = row as Row;
    const card = mapCard(raw);
    const state = mapState({
      ...raw,
      card_id: card.id,
      owner_user_id: raw.state_owner_user_id,
      workspace_id: input.workspaceId,
      updated_at: raw.state_updated_at,
    });
    const memberCourseIds = extractMemberCourseIds(raw.member_course_ids);
    return {
      card,
      state,
      goalPriority: Number(raw.goal_priority ?? 0),
      delayedCheckCovered: Boolean(raw.delayed_check_covered),
      memberCourseIds,
    };
  });

  const candidateCourseIds = new Set<string>();
  let needsSkillLabelLookup = false;
  for (const entry of mappedRows) {
    if (entry.card.courseId) candidateCourseIds.add(entry.card.courseId);
    for (const courseId of entry.memberCourseIds) candidateCourseIds.add(courseId);
    if (!entry.card.syllabusPointId && normalizeSkillLabel(entry.card.skillLabel)) {
      needsSkillLabelLookup = true;
    }
  }

  const examSkillWeights = await loadBoundExamSkillWeights(
    sql,
    { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId },
    [...candidateCourseIds],
    needsSkillLabelLookup,
  );

  // Leave knowledgeUnitKey / familyKey unset so buildReviewQueue auto-derives them via
  // the canonical domain helpers, guaranteeing identical server and client dedup keys.
  const items: ReviewQueueItem[] = mappedRows.map((entry) => {
    const meanPoints = resolveCardHistoricalMeanPoints(entry.card, entry.memberCourseIds, examSkillWeights);
    const syllabusWeight = meanPoints !== undefined && Number.isFinite(meanPoints)
      ? Math.max(0, meanPoints)
      : undefined;
    return {
      card: entry.card,
      state: entry.state,
      goalPriority: entry.goalPriority,
      ...(syllabusWeight !== undefined ? { syllabusWeight } : {}),
      ...(entry.delayedCheckCovered ? { delayedCheckCovered: true } : {}),
    };
  });

  const queueOptions = input.maxSessionCards !== undefined
    ? { maxSessionCards: input.maxSessionCards }
    : undefined;

  return buildReviewQueue(items, mode, now, today, queueOptions).map(
    (item): CardQueueEntry => ({
      card: item.card as CardRecord,
      state: {
        ...item.state,
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
      },
      goalPriority: item.goalPriority,
    }),
  );
}
