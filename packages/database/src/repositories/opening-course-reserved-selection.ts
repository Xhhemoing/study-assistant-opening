import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { courseRequirementSchema, questionSourceRefSchema, teachingQuestionInteractionSchema, type CourseRequirement, type ReservedRetestQualification, type Scope } from "@aistudy/contracts";
import { checkArithmeticAnswer } from "@aistudy/domain";
import { reservedArithmeticIdentity } from "./opening-reserved-arithmetic-identity";
export { reservedArithmeticIdentity } from "./opening-reserved-arithmetic-identity";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { readCourseQuestionExposure, recordCourseQuestionExposure } from "./opening-course-question-exposure";

type Db = Sql | TransactionSql;
// Private storage identity, NOT a member of the public questionRef union. No invented library IDs.
const identitySchema = z.object({ protocolVersion: z.literal("reserved-arithmetic-1"), identityRefId: z.string().uuid(),
  reservedQuestionId: z.string().uuid(), requirementId: z.string().uuid(), requirementRevision: z.number().int().positive(),
  sourceRefs: z.array(questionSourceRefSchema).min(1), expression: z.string(), familyId: z.string(), answerRole: z.literal("answer_key") }).strict();
const candidateSchema = z.object({ text: z.string().trim().min(1).max(400), interaction: teachingQuestionInteractionSchema,
  answer: z.string().trim().min(1).max(1200) }).strict();
export type OpeningReservedCandidate = z.infer<typeof candidateSchema>;
export type OpeningReservedPinnedContext = { courseId: string; requirementId: string; requirementRevision: number; sourceVersions: Record<string, number> };
export type OpeningReservedDemand = { kind: "new_question" } | { kind: "same_family"; familyId: string } | { kind: "new_family"; excludedFamilyIds: string[] };
export type OpeningReservedSupply = { status: "ready" | "missing" | "unknown"; available: number; reason: string | null };
export type OpeningReservedExposureInput = {
  reservedQuestionId: string; identityRefId: string; courseId: string; requirementId: string; requirementRevision: number;
  sourceVersions: Record<string, number>; text: string; interaction: OpeningReservedCandidate["interaction"]; familyId: string;
};
export type OpeningReservedExposureResult = { coverage: "complete" | "unknown"; exactExposed: boolean; familyExposed: boolean; reason: string | null };
/** Server-only dependency. Phase 2 supplies the durable, watermark-checked ledger.
 * Never populate from HTTP/model flags. Unwired production remains unknown.
 */
export type OpeningReservedExposureReader = (db: Db, scope: Scope, input: OpeningReservedExposureInput) => Promise<OpeningReservedExposureResult>;
export type OpeningReservedPorts = { readExposure: OpeningReservedExposureReader };

/** Server-only capability, captured before generation; never accepted in candidate JSON. */
type AdmissionOptions = { assertPinnedContext: (tx: TransactionSql) => Promise<void> };

async function currentRequirement(db: Db, scope: Scope, courseId: string, requirementId: string) {
  const [row] = await db`SELECT * FROM course_requirements WHERE id=${requirementId} AND course_id=${courseId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND lifecycle='active' AND approved_at IS NOT NULL`;
  if (!row) throw learningError("CONFLICT", "保留题要求未确认或已变化。");
  return courseRequirementSchema.parse({ id: row.id, courseId: row.course_id, stableSkillId: row.stable_skill_id, knowledgeNodeId: row.knowledge_node_id,
    requirementKey: row.requirement_key, title: row.title, position: Number(row.position), mandatory: row.mandatory, goalIds: row.goal_ids,
    prerequisiteIds: row.prerequisite_ids, sourceRefs: row.source_refs, verification: row.verification, revision: Number(row.revision),
    lifecycle: row.lifecycle, origin: row.origin, approvedAt: new Date(row.approved_at).toISOString() });
}
async function sourcesCurrent(db: Db, scope: Scope, requirement: CourseRequirement, lock = false) {
  if (!requirement.sourceRefs.length) return false;
  const ids = [...new Set(requirement.sourceRefs.map(ref => ref.sourceId))].sort();
  const rows = await db`SELECT s.id,s.version FROM opening_sources s JOIN course_asset_memberships m
    ON m.asset_id=s.id AND m.workspace_id=s.workspace_id AND m.asset_type='source' AND m.course_id=${requirement.courseId}
    WHERE s.workspace_id=${scope.workspaceId} AND s.id IN ${db(ids)} AND s.upload_state='uploaded' AND s.parse_state='ready'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) ${lock ? db`FOR SHARE OF s` : db``}`;
  if (!requirement.sourceRefs.every(ref => rows.some(row => row.id === ref.sourceId && Number(row.version) === ref.sourceVersion))) return false;
  for (const ref of requirement.sourceRefs) {
    const chunks = await db`SELECT id FROM opening_source_chunks WHERE source_id=${ref.sourceId} AND source_version=${ref.sourceVersion}
      AND (${ref.chunkId ?? null}::uuid IS NULL OR id=${ref.chunkId ?? null}) AND (${ref.page ?? null}::int IS NULL OR page=${ref.page ?? null})`;
    if (!chunks.length) return false;
  }
  return true;
}

function trustedRow(row: Record<string, unknown>, requirement: CourseRequirement) {
  const identity = identitySchema.safeParse(row.identity_json), question = candidateSchema.safeParse({
    ...(row.question_json as object), interaction: row.interaction_json, answer: (row.key_json as { answer?: unknown })?.answer });
  if (!identity.success || !question.success || question.data.interaction.kind !== "numeric" || question.data.interaction.unit) return null;
  const exact = reservedArithmeticIdentity(question.data.text), key = row.key_json as Record<string, unknown>;
  const refs = requirement.sourceRefs.map(ref => ({ sourceId: ref.sourceId, version: ref.sourceVersion,
    ...(ref.chunkId ? { chunkId: ref.chunkId } : {}), ...(ref.page ? { page: ref.page } : {}) }));
  if (!exact || identity.data.reservedQuestionId !== row.id || identity.data.identityRefId !== row.identity_ref_id
    || identity.data.requirementId !== requirement.id || identity.data.requirementRevision !== requirement.revision
    || !isDeepStrictEqual(identity.data.sourceRefs, refs) || identity.data.expression !== exact.expression || identity.data.familyId !== exact.familyId
    || row.family_id !== exact.familyId || key.keyRefId !== row.key_ref_id || !isDeepStrictEqual(key.identity, identity.data)
    || !isDeepStrictEqual(key.verification, { kind: "deterministic_evaluator", evaluatorId: "arithmetic", evaluatorVersion: "reserved-arithmetic-1" })
    || !isDeepStrictEqual(row.source_versions, Object.fromEntries(refs.map(ref => [ref.sourceId, ref.version])))
    || checkArithmeticAnswer(exact.expression, question.data.answer) !== "correct") return null;
  return { question: question.data, exact, identity: identity.data };
}

async function persistCandidates(sql: Sql, scope: Scope, activityId: string, raw: unknown,
  options: AdmissionOptions, pinned?: OpeningReservedPinnedContext): Promise<string[]> {
  if (typeof options?.assertPinnedContext !== "function") throw learningError("CONFLICT", "保留题缺少原始生成用途授权。");
  // Dedicated provider output is untrusted. No key/history/identity claims are accepted.
  const candidates = candidateSchema.array().max(12).parse(raw);
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    // Same transaction as INSERT: source/membership locks survive until commit.
    await options.assertPinnedContext(tx);
    const context = await assertOpeningCourseRouteCurrent(tx, scope, activityId);
    if (!context) throw learningError("VALIDATION", "保留题只能由课程编译供给。");
    const [activity] = await tx`SELECT course_id FROM opening_teaching_activities WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const requirement = await currentRequirement(tx, scope, String(activity!.course_id), context.requirementId);
    if (!await sourcesCurrent(tx, scope, requirement, true)) throw learningError("CONFLICT", "保留题材料已变化。");
    if (pinned && (pinned.courseId !== requirement.courseId || pinned.requirementId !== requirement.id
      || pinned.requirementRevision !== requirement.revision || !isDeepStrictEqual(pinned.sourceVersions,
        Object.fromEntries(requirement.sourceRefs.map(ref => [ref.sourceId, ref.sourceVersion])))))
      throw learningError("CONFLICT", "生成保留题的要求或材料快照已变化。");
    // This first producer supports the explicit arithmetic requirement only.
    // Solving a generated sum does not establish that it tests rank, limits or another skill.
    if (requirement.requirementKey !== "arithmetic" || requirement.verification.kind !== "exact") return [];
    const saved: string[] = [];
    for (const question of candidates) {
      const exact = reservedArithmeticIdentity(question.text);
      if (!exact || question.interaction.kind !== "numeric" || question.interaction.unit || checkArithmeticAnswer(exact.expression, question.answer) !== "correct") continue;
      const previous = await tx`SELECT identity_json FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND course_id=${requirement.courseId} AND requirement_id=${requirement.id} AND requirement_revision=${requirement.revision}`;
      if (previous.some(row => (row.identity_json as { expression?: string }).expression === exact.expression)) continue;
      const id = randomUUID(), identityRefId = randomUUID(), keyRefId = randomUUID();
      const refs = requirement.sourceRefs.map(ref => ({ sourceId: ref.sourceId, version: ref.sourceVersion,
        ...(ref.chunkId ? { chunkId: ref.chunkId } : {}), ...(ref.page ? { page: ref.page } : {}) }));
      const identity = identitySchema.parse({ protocolVersion: "reserved-arithmetic-1", identityRefId, reservedQuestionId: id,
        requirementId: requirement.id, requirementRevision: requirement.revision, sourceRefs: refs, expression: exact.expression,
        familyId: exact.familyId, answerRole: "answer_key" });
      const key = { keyRefId, identity, answer: question.answer,
        verification: { kind: "deterministic_evaluator", evaluatorId: "arithmetic", evaluatorVersion: "reserved-arithmetic-1" } };
      await tx`INSERT INTO opening_course_reserved_questions(id,workspace_id,owner_user_id,course_id,requirement_id,requirement_revision,
        source_versions,identity_ref_id,identity_json,family_id,content_ref_id,key_ref_id,question_json,interaction_json,key_json)
        VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${requirement.courseId},${requirement.id},${requirement.revision},
          ${tx.json(Object.fromEntries(refs.map(ref => [ref.sourceId, ref.version])))},${identityRefId},${tx.json(identity)},${exact.familyId},${randomUUID()},${keyRefId},
          ${tx.json({ text: question.text })},${tx.json(question.interaction)},${tx.json(key)})`;
      saved.push(id);
    }
    return saved;
  });
}

/** Legacy batch API has no production caller; it requires the same original-pin capability. */
export async function saveOpeningReservedCandidates(sql: Sql, scope: Scope, activityId: string, raw: unknown, options: AdmissionOptions): Promise<number> {
  return (await persistCandidates(sql, scope, activityId, raw, options)).length;
}
export async function admitOpeningReservedCandidate(sql: Sql, scope: Scope, activityId: string,
  pinned: OpeningReservedPinnedContext, candidate: OpeningReservedCandidate, options: AdmissionOptions): Promise<{ privateRefId: string } | null> {
  const [privateRefId] = await persistCandidates(sql, scope, activityId, [candidate], options, pinned);
  return privateRefId ? { privateRefId } : null;
}

export async function readOpeningReservedSupply(db: Db, scope: Scope, requirement: CourseRequirement, demand: OpeningReservedDemand = { kind: "new_question" }, ports?: OpeningReservedPorts): Promise<OpeningReservedSupply> {
  const { supply } = await eligibleRows(db, scope, requirement, demand, undefined, ports);
  return supply;
}
async function eligibleRows(db: Db, scope: Scope, requirement: CourseRequirement, demand: OpeningReservedDemand, reservationActivityId?: string, ports?: OpeningReservedPorts) {
  // Unsupported production means missing private inventory, not a statement
  // about historical exposure or the learner's verified performance.
  if (requirement.requirementKey !== "arithmetic" || requirement.verification.kind !== "exact") return { rows: [],
    supply: { status: "missing", available: 0, reason: "本要求的私有生成与身份校验题型尚不支持" } as OpeningReservedSupply };
  const exposure = ports ?? { readExposure: readCourseQuestionExposure };
  if (!await sourcesCurrent(db, scope, requirement)) return { rows: [], supply: { status: "missing", available: 0, reason: "当前要求材料不可用" } as OpeningReservedSupply };
  const candidates = await db`SELECT * FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND course_id=${requirement.courseId} AND requirement_id=${requirement.id} AND requirement_revision=${requirement.revision}
    AND (state='available' OR state='reserved' AND reserved_activity_id=${reservationActivityId ?? null}) ORDER BY created_at,id`;
  const rows: typeof candidates[number][] = [];
  for (const row of candidates) {
    const trusted = trustedRow(row, requirement);
    if (!trusted) continue;
    const history = await exposure.readExposure(db, scope, { reservedQuestionId: String(row.id), identityRefId: String(row.identity_ref_id),
      courseId: requirement.courseId, requirementId: requirement.id, requirementRevision: requirement.revision,
      sourceVersions: row.source_versions as Record<string, number>, text: trusted.question.text,
      interaction: trusted.question.interaction, familyId: trusted.exact.familyId });
    if (history.coverage !== "complete") return { rows: [], supply: { status: "unknown", available: 0,
      reason: history.reason ?? "曝光历史覆盖不完整" } as OpeningReservedSupply };
    if (history.exactExposed) continue;
    if (demand.kind === "same_family" && trusted.exact.familyId !== demand.familyId) continue;
    if (demand.kind === "new_family" && (demand.excludedFamilyIds.includes(trusted.exact.familyId) || history.familyExposed)) continue;
    rows.push(row);
  }
  return { rows, supply: { status: rows.length ? "ready" : "missing", available: rows.length,
    reason: rows.length ? null : "缺少当前可信、未曝光且满足题族要求的保留题" } as OpeningReservedSupply };
}

/** Caller already owns the workspace history lock and activity transaction. */
export async function reserveOpeningCourseQuestion(tx: TransactionSql, scope: Scope, requirement: CourseRequirement, activityId: string, demand: OpeningReservedDemand, ports?: OpeningReservedPorts) {
  await lockWorkspaceLearningHistory(tx, scope);
  const current = await currentRequirement(tx, scope, requirement.courseId, requirement.id);
  const context = await assertOpeningCourseRouteCurrent(tx, scope, activityId);
  if (!context || context.requirementId !== current.id || requirement.revision !== current.revision)
    throw learningError("CONFLICT", "保留题要求或目标活动已变化。");
  if (!await sourcesCurrent(tx, scope, current, true)) throw learningError("CONFLICT", "保留题材料已变化。");
  const { rows, supply } = await eligibleRows(tx, scope, current, demand, undefined, ports);
  if (!rows[0]) throw learningError("CONFLICT", supply.reason ?? "保留题不足。");
  const [saved] = await tx`UPDATE opening_course_reserved_questions SET state='reserved',reservation_key=${`course-reserved:${activityId}`},
    reserved_activity_id=${activityId},reserved_at=clock_timestamp() WHERE id=${String(rows[0].id)} AND state='available' RETURNING id`;
  if (!saved) throw learningError("CONFLICT", "保留题已被其他活动占用。");
  return String(saved.id);
}

/** Publish ONLY the selected prompt, and create its real canonical attempt atomically.
 * No answer block is created: the key remains in the private table even after issuance.
 */
export async function issueOpeningReservedQuestion(tx: TransactionSql, scope: Scope, activityId: string, ports?: OpeningReservedPorts) {
  await lockWorkspaceLearningHistory(tx, scope);
  const [reserved] = await tx`SELECT * FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND reserved_activity_id=${activityId} AND state IN ('reserved','issued') FOR UPDATE`;
  if (!reserved || reserved.state === "issued") return;
  const context = await assertOpeningCourseRouteCurrent(tx, scope, activityId);
  if (!context) throw learningError("CONFLICT", "保留题活动绑定不可用。");
  const [activity] = await tx`SELECT status,content_version FROM opening_teaching_activities WHERE id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (activity?.status !== "active" || Number(activity.content_version) !== 0) throw learningError("CONFLICT", "保留题活动不可发题。");
  const requirement = await currentRequirement(tx, scope, String(reserved.course_id), context.requirementId);
  if (!await sourcesCurrent(tx, scope, requirement, true)) throw learningError("CONFLICT", "保留题材料已变化。");
  const demand: OpeningReservedDemand = context.action === "transfer_check" || context.action === "comprehensive"
    ? { kind: "new_family", excludedFamilyIds: [] } : { kind: "new_question" };
  const eligible = await eligibleRows(tx, scope, requirement, demand, activityId, ports);
  if (!eligible.rows.some(row => row.id === reserved.id)) throw learningError("CONFLICT", eligible.supply.reason ?? "保留题资格已改变。");
  const trusted = trustedRow(reserved, requirement)!;
  const documentId = randomUUID(), unitId = randomUUID(), revisionId = randomUUID(), blockId = randomUUID();
  const blocks = [{ id: blockId, type: "prompt", position: 0, content: { text: trusted.question.text, interaction: trusted.question.interaction } }];
  const order = [{ blockId, blockType: "prompt", role: "prompt", position: 0 }];
  const refs = trusted.identity.sourceRefs;
  await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number) VALUES(${documentId},${scope.workspaceId},${requirement.title},'published',1)`;
  await tx`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,title,lifecycle,reason,blocks)
    VALUES(${revisionId},${scope.workspaceId},${documentId},1,${requirement.title},'published','reserved-question-issued',${tx.json(blocks)})`;
  await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
    VALUES(${blockId},${scope.workspaceId},${documentId},'prompt',0,${tx.json(blocks[0]!.content)})`;
  await tx`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number)
    VALUES(${unitId},${scope.workspaceId},${scope.ownerUserId},${requirement.title},${documentId},1)`;
  await tx`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,revision_number,block_order,source_refs,version)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${activityId},${unitId},${documentId},1,${tx.json(order)},${tx.json(refs)},1)`;
  await tx`UPDATE opening_teaching_activities SET content_version=1,generate_status='needs_check',updated_at=now()
    WHERE id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND content_version=0`;
  const { createOpeningLearningSessionInTx } = await import("./opening-learning-session-create");
  const { createOpeningLearningAttemptInTx } = await import("./opening-learning-attempts");
  const session = await createOpeningLearningSessionInTx(tx, scope, { activityId, courseId: requirement.courseId,
    sourceIds: [...new Set(refs.map(ref => ref.sourceId))], skillLabel: requirement.title });
  const attempt = await createOpeningLearningAttemptInTx(tx, scope, { sessionId: session.id, clientKey: `reserved-issued:${reserved.id}`,
    teachingBlock: { blockId, contentVersion: 1 } });
  await tx`UPDATE opening_course_reserved_questions SET state='issued',issued_item_version_id=${attempt.itemVersionId!},issued_at=clock_timestamp()
    WHERE id=${String(reserved.id)} AND state='reserved'`;
  // Capture the conservative diagnostic in the same transaction, before the
  // public presentation receipt. This is NOT an independence/exposure claim.
  const qualification = reservedRetestUnavailable();
  await tx`UPDATE opening_learning_attempts SET create_intent=create_intent ||
    ${tx.json({ reservedRetestQualification: qualification })}::jsonb WHERE id=${attempt.id}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  await recordCourseQuestionExposure(tx, scope, { surfaceKey: `issued:${reserved.id}`, kind: "presented",
    text: trusted.question.text, identityRefId: String(reserved.identity_ref_id), itemVersionId: attempt.itemVersionId!,
    sourceVersions: reserved.source_versions as Record<string, number> });
}

/** Server grading only. Never return the private row/key via a client-facing mapper. */
export async function readOpeningReservedKey(db: Db, scope: Scope, itemVersionId: string) {
  const [row] = await db`SELECT * FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND issued_item_version_id=${itemVersionId} AND state='issued'`;
  if (!row || row.state !== "issued" || row.issued_item_version_id !== itemVersionId) return null;
  const requirement = await currentRequirement(db, scope, String(row.course_id), String(row.requirement_id));
  const trusted = trustedRow(row, requirement);
  if (!trusted || !await sourcesCurrent(db, scope, requirement)) throw learningError("CONFLICT", "保留题键或材料版本已失效。");
  return { text: trusted.question.text, answer: trusted.question.answer, interaction: trusted.question.interaction, sourceRefs: trusted.identity.sourceRefs };
}

/** Reuse the issued immutable item for retries/new sessions, never create a second owner. */
export async function readOpeningReservedIssuedItem(db: Db, scope: Scope, activityId: string, blockId: string) {
  const [row] = await db`SELECT v.*,q.id AS reserved_question_id FROM opening_course_reserved_questions q JOIN opening_learning_item_versions v
    ON v.id=q.issued_item_version_id AND v.workspace_id=q.workspace_id AND v.owner_user_id=q.owner_user_id
    WHERE q.workspace_id=${scope.workspaceId} AND q.owner_user_id=${scope.ownerUserId} AND q.reserved_activity_id=${activityId}
      AND q.state='issued' AND v.teaching_block_id=${blockId}`;
  return row ?? null;
}

/** Server evidence only, never HTTP/model/self-report flags. Each true must be
 * established by its fact owner, not inferred from a deterministic verdict.
 * Content, purpose, sources and identity are distinct; history is BEFORE issue,
 * whereas help/reveal must remain excluded through answer submission.
 */
type Evidence = Partial<Record<"contentCurrent" | "purposeCurrent" | "sourcesCurrent" | "stableIdentity"
  | "preIssueHistoryComplete" | "previouslyUnseen" | "noHelp" | "noAnswerReveal" | "independentBlindSolve", boolean | null>>;
const checks = [
  ["contentCurrent", "content_version_unconfirmed", "题目内容版本尚未核实。"],
  ["purposeCurrent", "purpose_pin_unconfirmed", "原始材料用途回执尚未核实。"],
  ["sourcesCurrent", "source_version_unconfirmed", "来源材料版本尚未核实。"],
  ["stableIdentity", "stable_identity_missing", "保留题身份尚未接入独立作答证据规则。"],
  ["preIssueHistoryComplete", "pre_issue_history_missing", "缺少可供独立复测使用的发题前历史凭据，不能用发题后的曝光反推。"],
  ["previouslyUnseen", "unseen_evidence_missing", "缺少与本次题目绑定的未见保留题凭据。"],
  ["noHelp", "help_not_excluded", "尚不能确认本次独立作答全程未使用帮助。"],
  ["noAnswerReveal", "answer_reveal_not_excluded", "尚不能确认本次独立作答前未查看答案。"],
  ["independentBlindSolve", "independent_blind_solve_missing", "缺少独立盲解核验证据；确定性判分不等于独立复测。"],
] as const;

export function evaluateReservedRetestQualification(evidence: Evidence): ReservedRetestQualification {
  const reasons = checks.filter(([field]) => evidence[field] !== true).map(([, code, message]) => ({ code, message }));
  return { eligible: reasons.length === 0, reasons };
}

/** Current reserved-arithmetic path validates these three pins before issuing
 * and again before grading. It has NO independent identity/blind-solve bridge.
 * Do not invent one from answer correctness, a request flag or current exposure.
 * The returned diagnostic is always unavailable and grants no evidence rights.
 */
export function reservedRetestUnavailable(): ReservedRetestQualification {
  return evaluateReservedRetestQualification({ contentCurrent: true, purposeCurrent: true, sourcesCurrent: true });
}

/** Safe fallback for old hinted receipts and pure attempt mappers, which cannot
 * revalidate live pins. Never trust persisted eligible=true as a capability. */
export function unconfirmedReservedRetestQualification(): ReservedRetestQualification {
  return evaluateReservedRetestQualification({});
}
