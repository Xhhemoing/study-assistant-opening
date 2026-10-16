import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import {
  measurementActionInputSchema, measurementNextInputSchema, measurementStartInputSchema, measurementStatusInputSchema,
  type MeasurementActionInput, type MeasurementExport, type MeasurementNextInput, type MeasurementOverview,
  type MeasurementStartInput, type MeasurementStatusInput, type Scope,
} from "@aistudy/contracts";
import { MEASUREMENT_MODELS, predictMeasurementPair, resolveMeasurementPlugins } from "@aistudy/domain";
import { chooseNextMeasurementItem, getMeasurementUnit, gradeMeasurementAnswer } from "@aistudy/domain/measurement-catalog";
import { learningError } from "./opening-learning-facts";
import {
  lockMeasurementCourse, lockMeasurementTrial, mapMeasurementAttempt, mapMeasurementTrial,
  measurementAttemptRows, measurementCatalog, measurementNow, measurementOverview, measurementPhaseComplete,
  parseMeasurementItem, recordMeasurementCommand, replayMeasurementCommand,
} from "./opening-measurement-facts";

/** Isolated opt-in plugin. No production observations, planner facts, or mastery states are written. */
export function createOpeningMeasurementRepository(sql: Sql) {
  return {
    async start(scope: Scope, raw: MeasurementStartInput): Promise<MeasurementOverview> {
      const input = measurementStartInputSchema.parse(raw);
      const unit = getMeasurementUnit(input.unitId);
      if (!unit) throw learningError("VALIDATION", "测量单元不可用");
      return sql.begin(async tx => {
        // Serialize enrollment before checking uniqueness; do not upgrade a shared lock.
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw learningError("NOT_FOUND", "工作区不存在");
        await lockMeasurementCourse(tx, scope, input.courseId);
        const intent = { courseId: input.courseId, unitId: input.unitId };
        const replay = await tx`SELECT * FROM opening_measurement_trials WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (replay[0]) {
          if (!isDeepStrictEqual(replay[0].create_intent, intent)) throw learningError("CONFLICT", "相同请求标识不能用于其他测量单元");
          return measurementOverview(tx, replay[0]);
        }
        const existing = await tx`SELECT * FROM opening_measurement_trials WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND unit_id=${input.unitId}`;
        if (existing[0]) {
          if (existing[0].course_id !== input.courseId) throw learningError("CONFLICT", `该单元已在课程 ${String(existing[0].course_id)} 开始，请返回原课程继续；重复开测会泄漏保留题`);
          return measurementOverview(tx, existing[0]);
        }
        const [row] = await tx`INSERT INTO opening_measurement_trials
          (id,workspace_id,owner_user_id,course_id,unit_id,protocol_version,bank_version,models,catalog,selection_policy,status,client_key,create_intent)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${input.unitId},${unit.protocolVersion},${unit.bankVersion},
          ${tx.json(MEASUREMENT_MODELS as never)},${tx.json(unit.items as never)},'fixed-common-probes-v1','active',${input.clientKey},${tx.json(intent)}) RETURNING *`;
        return measurementOverview(tx, row!);
      });
    },

    async read(scope: Scope, courseId: string): Promise<MeasurementOverview> {
      return sql.begin(async tx => {
        await lockMeasurementCourse(tx, scope, courseId, true);
        const rows = await tx`SELECT * FROM opening_measurement_trials WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND unit_id='calculus-parts-v1' FOR SHARE`;
        if (rows[0] && rows[0].course_id !== courseId) await lockMeasurementCourse(tx, scope, String(rows[0].course_id), true);
        return measurementOverview(tx, rows[0] ?? null);
      });
    },

    async setStatus(scope: Scope, raw: MeasurementStatusInput): Promise<MeasurementOverview> {
      const input = measurementStatusInputSchema.parse(raw);
      return sql.begin(async tx => {
        const current = await lockMeasurementTrial(tx, scope, input.trialId);
        if (current.status === "completed") throw learningError("CONFLICT", "已完成的测量不能重置；可撤回错误记录");
        const [row] = await tx`UPDATE opening_measurement_trials SET status=${input.status} WHERE id=${input.trialId} RETURNING *`;
        return measurementOverview(tx, row!);
      });
    },

    async next(scope: Scope, raw: MeasurementNextInput): Promise<MeasurementOverview> {
      const input = measurementNextInputSchema.parse(raw);
      return sql.begin(async tx => {
        const row = await lockMeasurementTrial(tx, scope, input.trialId);
        const intent = { action: "next" };
        if (await replayMeasurementCommand(tx, input.trialId, input.clientKey, intent)) return measurementOverview(tx, row);
        const trial = mapMeasurementTrial(row);
        if (trial.status !== "active") throw learningError("CONFLICT", "请先恢复测量；已完成的单元不能重复开测");
        let plugins: ReturnType<typeof resolveMeasurementPlugins>;
        try { plugins = resolveMeasurementPlugins(trial.models); }
        catch { throw learningError("CONFLICT", "当前版本缺少该试验模型实现，请恢复相应版本；现有数据仍可导出"); }
        const items = measurementCatalog(row);
        const history = (await measurementAttemptRows(tx, trial.id)).map(mapMeasurementAttempt);
        const pending = history.find(attempt => attempt.answeredAt === null);
        if (pending) {
          await recordMeasurementCommand(tx, trial.id, pending.id, input.clientKey, intent);
          return measurementOverview(tx, row);
        }
        const now = await measurementNow(tx);
        const next = chooseNextMeasurementItem({ trial, attempts: history, items, now });
        if (!next.item) {
          if (next.complete) {
            const [completed] = await tx`UPDATE opening_measurement_trials SET status='completed' WHERE id=${trial.id} RETURNING *`;
            await recordMeasurementCommand(tx, trial.id, null, input.clientKey, intent);
            return measurementOverview(tx, completed!);
          }
          throw learningError("CONFLICT", `复测尚未到期，请在 ${next.dueAt ?? "计划时间"} 后继续`);
        }
        const attemptId = randomUUID();
        const predictions = predictMeasurementPair({ skillId: next.item.skillId, history, predictedAt: now, plugins });
        const firstAttempt = !history.some(attempt => attempt.item.id === next.item!.id);
        await tx`INSERT INTO opening_measurement_attempts
          (id,trial_id,ordinal,item_snapshot,first_attempt,predictions,presented_at,due_at)
          VALUES (${attemptId},${trial.id},${history.length + 1},${tx.json(next.item as never)},${firstAttempt},
            ${tx.json(predictions as never)},${now},${next.dueAt})`;
        await recordMeasurementCommand(tx, trial.id, attemptId, input.clientKey, intent);
        // The transaction commits both the prediction and question before either can reach the browser.
        return measurementOverview(tx, row);
      });
    },

    async act(scope: Scope, attemptId: string, raw: MeasurementActionInput): Promise<MeasurementOverview> {
      const input = measurementActionInputSchema.parse(raw);
      return sql.begin(async tx => {
        const found = await tx`SELECT a.trial_id FROM opening_measurement_attempts a JOIN opening_measurement_trials t ON t.id=a.trial_id
          WHERE a.id=${attemptId} AND t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}`;
        if (!found[0]) throw learningError("NOT_FOUND", "测量作答不存在");
        let row = await lockMeasurementTrial(tx, scope, String(found[0].trial_id));
        const trialId = String(row.id);
        const intent = { attemptId, ...input };
        if (await replayMeasurementCommand(tx, trialId, input.clientKey, intent)) return measurementOverview(tx, row);
        const rows = await measurementAttemptRows(tx, trialId);
        const stored = rows.find(attempt => attempt.id === attemptId)!;
        const attempt = mapMeasurementAttempt(stored);
        const item = parseMeasurementItem(stored.item_snapshot);
        const now = await measurementNow(tx);
        if (input.action === "retract") {
          if (attempt.answeredAt == null || attempt.retractedAt != null) throw learningError("CONFLICT", "只能撤回已提交且尚未撤回的作答");
          await tx`UPDATE opening_measurement_attempts SET retracted_at=${now},retraction_reason=${input.reason} WHERE id=${attemptId}`;
        } else {
          if (row.status !== "active") throw learningError("CONFLICT", "请先恢复测量");
          if (attempt.answeredAt != null) throw learningError("CONFLICT", "该题已提交；如记录有误请撤回，不覆盖原始记录");
          if (input.action === "help") {
            if (item.phase !== "practice" && input.kind !== "external") throw learningError("CONFLICT", "独立复测完成本轮后统一显示解析，过程中不提供提示");
            const help = [...attempt.helpEvents, { kind: input.kind, recordedAt: now }];
            const feedback = help.some(event => event.kind === "solution") ? item.solution : input.kind === "hint" ? item.hint : attempt.feedback;
            await tx`UPDATE opening_measurement_attempts SET help_events=${tx.json(help)},feedback=${feedback} WHERE id=${attemptId}`;
          } else {
            let outcome: "correct" | "incorrect" | "skipped" = "skipped";
            if (input.action === "answer") {
              if (!item.options.some(option => option.id === input.answer)) throw learningError("VALIDATION", "请选择该题提供的选项");
              outcome = gradeMeasurementAnswer(item, input.answer);
            }
            await tx`UPDATE opening_measurement_attempts SET answer=${input.action === "answer" ? input.answer : null},
              outcome=${outcome},answered_at=${now},feedback=${item.solution} WHERE id=${attemptId}`;
            const history = (await measurementAttemptRows(tx, trialId)).map(mapMeasurementAttempt);
            const items = measurementCatalog(row);
            if (row.practice_completed_at == null && measurementPhaseComplete(items, history, "practice")) {
              const [updated] = await tx`UPDATE opening_measurement_trials SET practice_completed_at=${now} WHERE id=${trialId} RETURNING *`;
              row = updated!;
            }
            if (items.every(candidate => history.some(record => record.item.id === candidate.id && record.answeredAt != null))) {
              const [updated] = await tx`UPDATE opening_measurement_trials SET status='completed' WHERE id=${trialId} RETURNING *`;
              row = updated!;
            }
          }
        }
        await recordMeasurementCommand(tx, trialId, attemptId, input.clientKey, intent);
        return measurementOverview(tx, row);
      });
    },

    async export(scope: Scope, courseId: string): Promise<MeasurementExport> {
      const overview = await this.read(scope, courseId);
      return { ...overview, format: "aistudy-measurement-v1", exportedAt: new Date().toISOString(), limitations: [
        "这是同一用户真实作答上的前瞻预测比较，不是随机对照学习效果实验。",
        "BKT 参数尚未用真实学习数据校准；样本量小不能证明学习提升。",
        "首次作答仅表示本工作区该单元内首次呈现，无法证明此前未在线下或其他工作区见过题目。",
        "题库覆盖有限的选择题能力；过程书写、开放证明和复杂分项评分尚未覆盖。",
        "提示、答案暴露、外部帮助、跳过、待答及撤回数据保留，但不计入独立作答预测得分。",
        "未完成的独立复测轮次隐藏评分和解析，导出遵守相同限制。",
        "48 小时复测主指标窗口为到期后 48 小时，7 天复测为到期后 72 小时；迟到仍记录，但排除该指标。",
        "7 天复测已受到 48 小时复测与其反馈影响，并非从未复测的纯保持率；距任一 48 小时作答不足 72 小时的记录也排除主指标。",
      ] };
    },
  };
}

export type OpeningMeasurementRepository = ReturnType<typeof createOpeningMeasurementRepository>;
