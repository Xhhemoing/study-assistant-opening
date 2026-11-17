import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository, type ExperimentalBktSnapshotInput } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import type { ExperimentalBktSnapshotHost, ExperimentalBktTrustedHostContext } from "../../apps/web/src/lib/experimental-bkt-snapshot-service-types";
import type { OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

export const cutoff = "2026-11-10T12:00:00.000Z";
// Independently solved catalogue answers, not projected eligibility/SQL rows.
// Five distinct canonical problems, three non-target families; no AI scoring.
const cases = [
  ["span-reserved-20261021-q08", ["0", "-1/2"]],
  ["span-reserved-20261021-q02", ["-3", "1"]],
  ["span-reserved-fraction", ["1/2", "-2/3"]],
  ["span-reserved-20261021-q05", ["-1/3", "3/4"]],
  ["span-reserved-20261021-q04", ["5/2", "0"]],
] as const;

export async function seedBktService(fixture: OpeningFixture) {
  const { sql, scope } = fixture, rows = backupRows(sql, scope);
  const sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${scope.workspaceId},'BKT service integration',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const start = (problemId: string) => attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId, version: 1 } });
  const target = await start("span-example-2d");
  const heads: Array<{ attempt: LearningAttempt; observation: LearningObservation }> = [];
  for (const [catalogueId, coefficients] of cases) {
    const attempt = await start(catalogueId);
    const observation = await learning.insertObservation(scope, { sessionId: session.id, courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients,
        equation: attempt.spanExercise, coordinateChecks: attempt.spanExercise!.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    heads.push({ attempt, observation });
  }
  // Explicit synthetic evidence times. We do not manufacture qualification or
  // claim naturally collected history. The production evaluator refreshes below.
  await sql`UPDATE opening_learning_item_versions SET created_at='2026-11-10T08:00:00Z' WHERE course_id=${courseId}`;
  await sql`UPDATE opening_learning_attempts SET started_at='2026-11-10T09:00:00Z' WHERE course_id=${courseId}`;
  for (const [index, head] of heads.entries()) {
    const submitted = `2026-11-10T10:0${index}:00.000Z`, recorded = `2026-11-10T10:0${index}:30.000Z`;
    await sql`UPDATE opening_learning_attempts SET submitted_at=${submitted} WHERE id=${head.attempt.id}`;
    await sql`UPDATE opening_learning_observations SET started_at='2026-11-10T09:00:00Z',
      submitted_at=${submitted},recorded_at=${recorded} WHERE id=${head.observation.id}`;
  }
  const refresh = () => sql.begin(tx => refreshOpeningLearningEligibility(tx, scope, heads.map(h => h.observation.id)));
  await refresh();
  const input: ExperimentalBktSnapshotInput = { courseId, requirementKey: SPAN_REQUIREMENT_KEY,
    problemId: target.problemId!, itemVersionId: target.itemVersionId!, cutoff };
  const repository = createOpeningExperimentalBktSnapshotRepository(sql);
  const context: ExperimentalBktTrustedHostContext = { scope, target: input,
    ruleInput: { status: "observed_independent", wantsFullExplanation: false },
    ruleDecision: { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } };
  // DI ONLY. These mutable test-owned grants model a host's liveness callbacks;
  // this is explicitly NOT an authenticated host/session producer or HTTP path.
  const grants = { current: true, prepare: true, compare: true, resolves: 0 };
  const host: ExperimentalBktSnapshotHost = {
    async resolveAuthenticatedContext() { grants.resolves++; return context; },
    isCurrent: () => grants.current, canPrepare: () => grants.prepare, canCompare: () => grants.compare,
  };
  const help = async () => {
    const head = heads[0]!, conversation = await rows.conversation(), turnId = await rows.turn(conversation, [sourceId]);
    await sql`UPDATE opening_turns SET learning_session_id=${session.id},attempt_id=${head.attempt.id} WHERE id=${turnId}`;
    return learning.insertHelpExposure(scope, { id: randomUUID(), sessionId: session.id, attemptId: head.attempt.id,
      problemId: head.attempt.problemId, turnId, kind: "hint", level: "hinted", delivered: true });
  };
  const targetError = () => learning.insertObservation(scope, { sessionId: session.id, courseId,
    skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: target.id, problemId: target.problemId,
    clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients: ["99", "99"],
      equation: target.spanExercise, coordinateChecks: target.spanExercise!.target }),
    outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  return { sql, scope, courseId, sourceId, input, heads, context, host, grants, repository, refresh, help, targetError };
}
export type BktServiceFixture = Awaited<ReturnType<typeof seedBktService>>;

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Transparent trace: every SQL tag/begin executes on the real driver. No rows,
 * contexts or transaction results are synthesized. Hooks run AFTER real context
 * SELECT, while the real read-only repeatable-read transaction remains open. */
export function traceBktSql(sql: Sql, options: {
  afterContext?: (tx: TransactionSql) => Promise<void>;
} = {}) {
  const transactions: Array<{ mode: string; settings: Record<string, unknown>;
    context: Record<string, unknown>; order: string[]; tokens: string[] }> = [];
  const traced = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (mode: string, consume: (tx: TransactionSql) => Promise<unknown>) => target.begin(mode, async tx => {
        const [settings] = await tx`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation,txid_current_snapshot()::text AS token`;
        const trace = { mode, settings: settings!, context: {} as Record<string, unknown>, order: [] as string[],
          tokens: [String(settings!.token)] };
        transactions.push(trace);
        const tagged = new Proxy(tx, {
          async apply(tag, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
            const query = args[0].join("?");
            const label = query.includes("clock_timestamp() AS data_as_of") ? "context"
              : query.includes("AS target_created_at") ? "target" : query.includes("WITH bindings AS") ? "heldout" : "heads";
            trace.order.push(label);
            const rows = await Reflect.apply(tag, thisArg, args);
            const [state] = await tx`SELECT txid_current_snapshot()::text AS token`;
            trace.tokens.push(String(state!.token));
            if (label === "context") {
              trace.context = rows[0];
              await options.afterContext?.(tx);
            }
            return rows;
          },
        });
        return consume(tagged);
      });
    },
  });
  return { sql: traced, transactions };
}
