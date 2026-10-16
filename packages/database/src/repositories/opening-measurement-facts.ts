import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  measurementAttemptSchema, measurementItemViewSchema, measurementTrialSchema,
  type MeasurementAttempt, type MeasurementOverview, type MeasurementPhase, type MeasurementTrial, type Scope,
} from "@aistudy/contracts";
import { buildMeasurementReport } from "@aistudy/domain";
import { chooseNextMeasurementItem, publicMeasurementItem, type MeasurementCatalogItem } from "@aistudy/domain/measurement-catalog";
import { learningError, learningIso, lockLearningOwner } from "./opening-learning-facts";

export type MeasurementRow = Record<string, unknown>;

/** Treat persisted JSON as input: fail visibly rather than grading corrupt snapshots. */
export function parseMeasurementItem(value: unknown): MeasurementCatalogItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw learningError("CONFLICT", "测量题目快照损坏");
  const raw = value as Record<string, unknown>;
  const { correctOptionId, hint, solution, ...visible } = raw;
  const item = measurementItemViewSchema.parse(visible);
  if (typeof correctOptionId !== "string" || !item.options.some(option => option.id === correctOptionId)
    || typeof hint !== "string" || typeof solution !== "string") throw learningError("CONFLICT", "测量评分快照损坏");
  return { ...item, correctOptionId, hint, solution };
}

export function measurementCatalog(row: MeasurementRow): MeasurementCatalogItem[] {
  if (!Array.isArray(row.catalog) || !row.catalog.length) throw learningError("CONFLICT", "测量题库快照损坏");
  const items = row.catalog.map(parseMeasurementItem);
  if (new Set(items.map(item => item.id)).size !== items.length) throw learningError("CONFLICT", "测量题目身份重复");
  return items;
}

export function mapMeasurementTrial(row: MeasurementRow): MeasurementTrial {
  return measurementTrialSchema.parse({
    id: row.id, courseId: row.course_id, unitId: row.unit_id,
    protocolVersion: row.protocol_version, bankVersion: row.bank_version,
    models: row.models, selectionPolicy: row.selection_policy, status: row.status,
    startedAt: learningIso(row.started_at), practiceCompletedAt: learningIso(row.practice_completed_at),
  });
}

export function mapMeasurementAttempt(row: MeasurementRow): MeasurementAttempt {
  return measurementAttemptSchema.parse({
    id: row.id, trialId: row.trial_id, ordinal: Number(row.ordinal),
    item: publicMeasurementItem(parseMeasurementItem(row.item_snapshot)),
    presentedAt: learningIso(row.presented_at), answeredAt: learningIso(row.answered_at), dueAt: learningIso(row.due_at),
    firstAttempt: row.first_attempt, helpEvents: row.help_events, answer: row.answer, outcome: row.outcome,
    retractedAt: learningIso(row.retracted_at), retractionReason: row.retraction_reason,
    predictions: row.predictions, feedback: row.feedback, feedbackWithheld: false,
  });
}

export async function lockMeasurementCourse(tx: TransactionSql, scope: Scope, courseId: string, includeArchived = false): Promise<void> {
  await lockLearningOwner(tx, scope);
  const courses = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
    AND (${includeArchived} OR archived_at IS NULL) FOR SHARE`;
  if (!courses.length) throw learningError("NOT_FOUND", "课程不存在或已归档");
}

export async function lockMeasurementTrial(tx: TransactionSql, scope: Scope, trialId: string): Promise<MeasurementRow> {
  await lockLearningOwner(tx, scope);
  const rows = await tx`SELECT t.* FROM opening_measurement_trials t JOIN courses c ON c.id=t.course_id AND c.workspace_id=t.workspace_id
    WHERE t.id=${trialId} AND t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}
      AND c.archived_at IS NULL FOR UPDATE OF t FOR SHARE OF c`;
  if (!rows[0]) throw learningError("NOT_FOUND", "测量记录不存在或课程已归档");
  return rows[0];
}

export async function measurementNow(tx: TransactionSql): Promise<string> {
  const [row] = await tx`SELECT clock_timestamp() AS now`;
  return learningIso(row!.now)!;
}

export async function measurementAttemptRows(tx: TransactionSql, trialId: string): Promise<MeasurementRow[]> {
  return tx`SELECT * FROM opening_measurement_attempts WHERE trial_id=${trialId} ORDER BY ordinal`;
}

export function measurementPhaseComplete(items: readonly MeasurementCatalogItem[], attempts: readonly MeasurementAttempt[], phase: MeasurementPhase): boolean {
  return items.filter(item => item.phase === phase).every(item => attempts.some(attempt => attempt.item.id === item.id && attempt.answeredAt != null));
}

/** Every client path, including export, uses the same withholding projection. */
export async function measurementOverview(tx: TransactionSql, row: MeasurementRow | null): Promise<MeasurementOverview> {
  if (!row) return { trial: null, attempts: [], nextDueAt: null, report: buildMeasurementReport([]) };
  const trial = mapMeasurementTrial(row);
  const items = measurementCatalog(row);
  const internal = (await measurementAttemptRows(tx, trial.id)).map(mapMeasurementAttempt);
  const attempts = internal.map(attempt => {
    if (attempt.answeredAt === null) return { ...attempt, predictions: [] };
    const withheld = attempt.item.phase !== "practice" && attempt.answeredAt != null
      && !measurementPhaseComplete(items, internal, attempt.item.phase);
    return withheld ? { ...attempt, feedbackWithheld: true, outcome: null, predictions: [], feedback: "已保存，完成本轮后查看解析" } : attempt;
  });
  const next = chooseNextMeasurementItem({ trial, attempts: internal, items, now: await measurementNow(tx) });
  return { trial, attempts, nextDueAt: next.dueAt, report: buildMeasurementReport(attempts, trial.models) };
}

export async function replayMeasurementCommand(tx: TransactionSql, trialId: string, key: string, intent: unknown): Promise<boolean> {
  const rows = await tx`SELECT intent FROM opening_measurement_commands WHERE trial_id=${trialId} AND client_key=${key}`;
  if (!rows[0]) return false;
  if (!isDeepStrictEqual(rows[0].intent, intent)) throw learningError("CONFLICT", "相同请求标识不能用于不同测量操作");
  return true;
}

export async function recordMeasurementCommand(tx: TransactionSql, trialId: string, attemptId: string | null, key: string, intent: unknown): Promise<void> {
  await tx`INSERT INTO opening_measurement_commands(id,trial_id,attempt_id,client_key,intent)
    VALUES (${randomUUID()},${trialId},${attemptId},${key},${tx.json(intent as never)})`;
}
