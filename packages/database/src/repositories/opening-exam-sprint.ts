import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  examSprintCommandSchema,
  type ExamIntegrationOverview, type ExamPack, type ExamSprintCommand, type ExamSprintOverview, type Scope,
} from "@aistudy/contracts";
import { applyExamSprintCommand, createExamSprintState, examSprintOverview } from "@aistudy/domain";
import { parseExamSprintSnapshot, OpeningExamSprintRepositoryError, corrupt } from "./opening-exam-sprint-snapshot";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { lockBoundExamCourse, packWithExamSourceMappings, readExamEvidenceState } from "./opening-exam-integration-facts";
import { syncExamIntegration } from "./opening-exam-integration-attempts";
import { readExamIntegrationInTx } from "./opening-exam-integration";
import { examSourceExposureCoverage, readExamSourceExposure } from "./opening-exam-source-exposure";
export { OpeningExamSprintRepositoryError } from "./opening-exam-sprint-snapshot";


async function lockOwner(tx: TransactionSql, scope: Scope, write: boolean) {
  const owner = write
    ? await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`
    : await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner.length) throw new OpeningExamSprintRepositoryError("NOT_FOUND", "工作区不存在");
}
async function nowIso(tx: TransactionSql): Promise<string> {
  const [row] = await tx`SELECT clock_timestamp() AS now`;
  return new Date(row!.now as string | Date).toISOString();
}

export type OpeningExamSprintExport = {
  format: "aistudy-exam-sprint-v1"; exportedAt: string;
  pack: ExamSprintOverview["pack"]; state: ExamSprintOverview["state"]; attempts: ExamSprintOverview["attempts"];
  commands: Array<{ id: string; clientKey: string; intent: ExamSprintCommand; recordedAt: string }>;
  integration: ExamIntegrationOverview;
};

/** Optional course binding publishes one canonical fact for each new, server-captured attempt. */
export function createOpeningExamSprintRepository(sql: Sql, pack: ExamPack) {
  // Parse once at the configuration boundary, also detaching caller-owned objects.
  const initialPack = parseExamSprintSnapshot(pack, createExamSprintState(new Date().toISOString())).pack;

  async function current(tx: TransactionSql, scope: Scope, now: string) {
    const [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
      WHERE course_id IS NULL AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    const snapshot = row ? parseExamSprintSnapshot(row.pack_snapshot, row.state)
      : { pack: initialPack, state: createExamSprintState(now) };
    if (row) snapshot.pack = await packWithExamSourceMappings(tx, String(row.id), snapshot.pack);
    return { id: row ? String(row.id) : null, ...snapshot };
  }

  return {
    async read(scope: Scope): Promise<ExamSprintOverview> {
      return sql.begin(async tx => {
        await lockOwner(tx, scope, false);
        const now = await nowIso(tx), snapshot = await current(tx, scope, now);
        return examSprintOverview(snapshot.state, snapshot.pack, now, snapshot.id ? await readExamEvidenceState(tx, scope, snapshot.id, snapshot.state) : undefined);
      });
    },

    async act(scope: Scope, raw: ExamSprintCommand): Promise<ExamSprintOverview> {
      const command = examSprintCommandSchema.parse(raw);
      return sql.begin(async tx => {
        // Serialize first-write creation too; a state-row lock alone cannot lock a missing row.
        await lockWorkspaceLearningHistory(tx, scope);
        await lockOwner(tx, scope, true);
        await lockBoundExamCourse(tx, scope);
        const now = await nowIso(tx);
        const [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
          WHERE course_id IS NULL AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const snapshot = row ? parseExamSprintSnapshot(row.pack_snapshot, row.state)
          : { pack: initialPack, state: createExamSprintState(now) };
        const sprintId = row ? String(row.id) : randomUUID();
        if (row) snapshot.pack = await packWithExamSourceMappings(tx, sprintId, snapshot.pack);
        const [receipt] = await tx`SELECT intent FROM opening_exam_sprint_commands
          WHERE sprint_id=${sprintId} AND client_key=${command.clientKey}`;
        if (receipt) {
          const parsed = examSprintCommandSchema.safeParse(receipt.intent);
          if (!parsed.success) return corrupt();
          if (!isDeepStrictEqual(parsed.data, command)) {
            throw new OpeningExamSprintRepositoryError("CONFLICT", "同一请求标识不能提交不同操作");
          }
          // A durable receipt does not authorize delivery in a different run or a sealed mock.
          // Revalidate against the captured pack/context without writing another exposure.
          if (command.action === "open_lesson") applyExamSprintCommand(snapshot.state, command, snapshot.pack, now);
          return examSprintOverview(snapshot.state, snapshot.pack, now, await readExamEvidenceState(tx, scope, sprintId, snapshot.state));
        }
        if (command.action === "configure") {
          const [bound] = await tx`SELECT sprint_id FROM opening_exam_bindings WHERE sprint_id=${sprintId}`;
          if (bound) throw new OpeningExamSprintRepositoryError("CONFLICT", "请到课程目标调整考试日期和时间预算");
        }
        const evidence = row ? await readExamEvidenceState(tx, scope, sprintId, snapshot.state) : { bktEligibleAttemptIds: [], ruleEvidence: {} };
        const capturesAttempt = ["start", "next", "open_lesson", "help", "answer"].includes(command.action);
        const captureId = command.action === "answer" || command.action === "help" ? command.attemptId
          : command.action === "open_lesson" ? snapshot.state.attempts.at(-1)?.id : undefined;
        const sourceExposure = row && capturesAttempt
          ? await readExamSourceExposure(tx, scope, sprintId, snapshot.pack, captureId) : null;
        if (sourceExposure?.sourceVersion === null) {
          throw new OpeningExamSprintRepositoryError("CONFLICT", "冲刺材料版本无法校验，请保留记录并联系维护者");
        }
        const context = { ...evidence, exposureCoverage: examSourceExposureCoverage(sourceExposure) };
        const state = applyExamSprintCommand(snapshot.state, command, snapshot.pack, now, context);
        if (row) {
          await tx`UPDATE opening_exam_sprints SET state=${tx.json(state as never)},updated_at=${now}
            WHERE id=${sprintId}`;
        } else {
          await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state,created_at,updated_at)
            VALUES(${sprintId},${scope.workspaceId},${scope.ownerUserId},${tx.json(snapshot.pack as never)},${tx.json(state as never)},${now},${now})`;
        }
        await syncExamIntegration(tx, scope, sprintId, snapshot.pack, snapshot.state, state, command, now);
        await tx`INSERT INTO opening_exam_sprint_commands(id,sprint_id,client_key,intent,recorded_at)
          VALUES(${randomUUID()},${sprintId},${command.clientKey},${tx.json(command)},${now})`;
        return examSprintOverview(state, snapshot.pack, now, await readExamEvidenceState(tx, scope, sprintId, state));
      });
    },

    async export(scope: Scope): Promise<OpeningExamSprintExport> {
      return sql.begin(async tx => {
        await lockOwner(tx, scope, false);
        const now = await nowIso(tx), snapshot = await current(tx, scope, now);
        const overview = examSprintOverview(snapshot.state, snapshot.pack, now, snapshot.id ? await readExamEvidenceState(tx, scope, snapshot.id, snapshot.state) : undefined);
        const rows = snapshot.id ? await tx`SELECT id,client_key,intent,recorded_at FROM opening_exam_sprint_commands
          WHERE sprint_id=${snapshot.id} ORDER BY recorded_at,id` : [];
        const commands = rows.map(row => {
          const parsed = examSprintCommandSchema.safeParse(row.intent);
          if (!parsed.success || parsed.data.clientKey !== row.client_key) return corrupt();
          return { id: String(row.id), clientKey: String(row.client_key), intent: parsed.data,
            recordedAt: new Date(row.recorded_at as string | Date).toISOString() };
        });
        return { format: "aistudy-exam-sprint-v1", exportedAt: now,
          pack: overview.pack, state: overview.state, attempts: overview.attempts, commands,
          integration: await readExamIntegrationInTx(tx, scope, snapshot.pack) };
      });
    },
  };
}

export type OpeningExamSprintRepository = ReturnType<typeof createOpeningExamSprintRepository>;
