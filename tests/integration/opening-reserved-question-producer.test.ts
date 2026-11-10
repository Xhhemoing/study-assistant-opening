import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createOpeningCourseReadySourcesRepository,
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository, readOpeningBackupRecords } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { admitOpeningReservedCandidate, readOpeningReservedSupply, reserveOpeningCourseQuestion, issueOpeningReservedQuestion } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import { produceReservedQuestion } from "../../packages/ai/src/opening/reserved-question-producer";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { uuidSchema, type CourseRouteRequirementInput } from "@aistudy/contracts";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningCourseRouteVerificationRepository } from "../../packages/database/src/repositories/opening-course-route-verification";
import { createOpeningCourseRouteRetestRepository } from "../../packages/database/src/repositories/opening-course-route-retest";
import { buildLongTermSuggestions } from "../../packages/database/src/repositories/opening-long-term-maintenance";
import { createOpeningTeachingContentService } from "../../apps/web/src/features/opening/teaching/teaching-content-service";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { GET as getRoute } from "../../apps/web/src/app/api/opening/courses/[id]/learning-route/route";
import { readCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });
async function setup() {
  const sourceId = await backupRows(f.sql, f.scope).source("uploaded", 1), chunkId = randomUUID(), courseId = randomUUID();
  await f.sql`UPDATE opening_sources SET mime='text/plain' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'Arithmetic operations on rational numbers.')`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Arithmetic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "Arithmetic", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "Independent arithmetic" });
  const definition: CourseRouteRequirementInput = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null,
    requirementKey: "arithmetic", title: "Arithmetic", position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "exact", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed" };
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const confirmed = await route.confirm(f.scope, courseId, { expectedRevisions: [], requirements: [definition], confirmScope: true });
  const requirement = confirmed.requirements[0]!.requirement;
  const activity = await route.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirement.id,
    expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (activity.kind !== "ready") throw new Error("activity not ready");
  const input = { scope: f.scope, courseId, requirementId: requirement.id, requirementRevision: 1, sourceVersions: { [sourceId]: 1 },
    requirementText: "rational arithmetic", evidence: { chunks: [] } };
  const purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: activity.activity.id, sourceIds: [sourceId], materialUse: "teaching" });
  const admission = { assertPinnedContext: (tx: TransactionSql) => purposes.assertSourcePurposePin(f.scope, pin, tx) };
  const admit = async (candidate: Parameters<Parameters<typeof produceReservedQuestion>[1]["admitAndPersist"]>[0]) => {
    const { scope, text, interaction, answer, ...pinned } = candidate;
    return admitOpeningReservedCandidate(f.sql, scope, activity.activity.id, pinned, { text, interaction, answer }, admission);
  };
  return { sourceId, chunkId, courseId, requirement, activityId: activity.activity.id, input, admit, admission, goal, definition };
}
const candidate = { text: "137*19", interaction: { kind: "numeric" as const }, answer: "2603" };
// Like the reserved-start privacy test, exempt only semantic ID paths AND a
// complete UUID. Never skip create_intent, context, receipts or body text.
function assertNoPrivateAnswer(value: unknown, answer: string, path: readonly string[] = []): void {
  if (typeof value === "string") {
    // Match actual path segments, never a dot-joined path: literal dotted keys
    // in arbitrary JSON are content, not trusted metadata references.
    const row = path[0] === "tables" && /^[a-z_]+$/.test(path[1] ?? "") && /^\d+$/.test(path[2] ?? "");
    const rowId = row && (path.length === 4 && /^(?:id|[a-z_]+_id)$/.test(path[3]!)
      || path.length === 5 && path[3] === "source_ids" && /^\d+$/.test(path[4]!));
    const contextField = /^(?:courseId|activityId|blockId|attemptId|itemVersionId|sourceId|chunkId)$/;
    const contextId = row && path[1] === "opening_learning_attempts"
      && (path.length === 5 && path[3] === "context_anchor" && contextField.test(path[4]!)
        || path.length === 6 && path[3] === "create_intent" && path[4] === "contextAnchor" && contextField.test(path[5]!));
    if ((rowId || contextId) && uuidSchema.safeParse(value).success) return;
    // Receipts may themselves be JSON strings. Parse only JSON containers, and
    // retain their original semantic path so their text is checked recursively.
    if (/^\s*[[{]/.test(value)) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { /* Non-JSON text is checked below. */ }
      if (parsed !== undefined) { assertNoPrivateAnswer(parsed, answer, path); return; }
    }
    expect(value, JSON.stringify(path)).not.toContain(answer);
  } else if (typeof value === "number") expect(String(value), JSON.stringify(path)).not.toContain(answer);
  else if (Array.isArray(value)) value.forEach((entry, index) => assertNoPrivateAnswer(entry, answer, [...path, String(index)]));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    expect(key, JSON.stringify(path)).not.toContain(answer);
    assertNoPrivateAnswer(entry, answer, [...path, key]);
  }
}
it("ignores answer digits only in UUID backup row IDs and context references", () => {
  const id = "9827300d-2603-4ad7-89cb-e5b00c25d4cb";
  const backup = { tables: {
    opening_learning_attempts: [{ id, context_anchor: { attemptId: id, purpose: "learning_help" },
      create_intent: { contextAnchor: { attemptId: id }, problem: null } }],
    opening_learning_shadow_predictions: [{ attempt_id: id, receipt: JSON.stringify({ mode: "shadow", predictions: [] }) }],
  } };
  // Deterministically reproduce the original raw-substring false positive.
  expect(JSON.stringify(backup)).toContain(candidate.answer);
  expect(() => assertNoPrivateAnswer(backup, candidate.answer)).not.toThrow();
  expect(() => assertNoPrivateAnswer(JSON.stringify(backup), candidate.answer)).not.toThrow();
});
it("still detects private answers in backup text, nested JSON and stringified receipts", () => {
  const id = "9827300d-2603-4ad7-89cb-e5b00c25d4cb";
  for (const row of [
    { id: candidate.answer }, { id: `prefix-${id}` }, { id: `${id}-suffix` },
    { text: `The answer is ${candidate.answer}.` }, { text: id },
    { create_intent: { problem: { answer: candidate.answer } } },
    { create_intent: { "contextAnchor.attemptId": id } },
    { "context_anchor.attemptId": id },
    { create_intent: JSON.stringify({ "contextAnchor.attemptId": id }) },
    { create_intent: { contextAnchor: { attemptId: candidate.answer } } },
    { context_anchor: { attemptId: `answer=${candidate.answer}` } },
    { context_anchor: { text: candidate.answer } },
    { context_anchor: { text: id } },
    { receipt: { nested: [{ answer: Number(candidate.answer) }] } },
    { receipt: JSON.stringify({ nested: { answer: candidate.answer } }) },
    { receipt: JSON.stringify({ nested: { text: id } }) },
    { receipt: '{"answer":"\\u0032\\u0036\\u0030\\u0033"}' },
    { receipt: `invalid JSON { answer: ${candidate.answer}` },
    { [candidate.answer]: "unexpected field" },
  ]) {
    const backup = { tables: { opening_learning_attempts: [row] } };
    expect(() => assertNoPrivateAnswer(backup, candidate.answer), JSON.stringify(row)).toThrow();
  }
});
// Observe actual SQL, including nested transaction clients, without stubbing rows.
function observedSql(db: Sql | TransactionSql, queries: string[]): Sql {
  return new Proxy(db, {
    apply(target, receiver, args) {
      if (Array.isArray(args[0]) && "raw" in args[0]) queries.push(args[0].join("?"));
      return Reflect.apply(target, receiver, args);
    },
    get(target, key, receiver) {
      if (key === "begin") return (...args: unknown[]) => (target as Sql).begin(
        ...(args.slice(0, -1) as []),
        tx => (args.at(-1) as (tx: TransactionSql) => Promise<unknown>)(observedSql(tx, queries) as unknown as TransactionSql),
      );
      return Reflect.get(target, key, receiver);
    },
  }) as Sql;
}
type LockSnapshot = {
  requester: { pid: number; began_at: string }; failed_at: string; sampled_at: string;
  observer_pid: number; requested_query: string; requested_mode: string; failed_relation: string | null; elapsed_ms: number;
  holder_assessment: string; visibility: string;
  locks: { pid: number | null; relation: string; mode: string; granted: boolean; candidate: boolean;
    backend_type: string | null; state: string | null; xact_start: string | null;
    wait_event_type: string | null; wait_event: string | null; query: string | null }[];
};
// Test-only evidence, not a retry or a holder attribution. NOWAIT can leave no
// waiting row, and a holder can disappear before this independent sample.
function lockDiagnosedSql(db: Sql | TransactionSql, snapshots: LockSnapshot[] = [], requester?: LockSnapshot["requester"]): Sql {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === "begin") return (...args: unknown[]) => Reflect.apply((target as Sql).begin, target, [
        ...args.slice(0, -1), async (tx: TransactionSql) => {
          const [backend] = await tx<{ pid: number; began_at: string }[]>`SELECT pg_backend_pid() AS pid, clock_timestamp()::text AS began_at`;
          const result = (args.at(-1) as (tx: TransactionSql) => unknown)(
            lockDiagnosedSql(tx, snapshots, backend!) as unknown as TransactionSql);
          // postgres.js permits a callback to return an array of lazy queries.
          return Array.isArray(result) ? Promise.all(result) : result;
        },
      ]);
      return Reflect.get(target, key, receiver);
    },
    apply(target, receiver, args) {
      const query = Reflect.apply(target, receiver, args);
      const text = Array.isArray(args[0]) && "raw" in args[0] ? args[0].join("?").replace(/\s+/g, " ").trim() : "";
      const lock = /^LOCK TABLE (.+) IN SHARE ROW EXCLUSIVE MODE NOWAIT$/i.exec(text);
      if (!lock || !requester) return query;
      let observed: Promise<unknown> | undefined;
      // Stay lazy, execute the original query once, and await diagnostics before
      // rejection. No queries are attempted on the now-aborted transaction.
      const observe = () => observed ??= query.then((rows: unknown) => rows, async (error: { code?: string; message?: string }) => {
        if (error.code === "55P03") {
          const failedAt = new Date().toISOString(), started = Date.now();
          try {
            const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
            const observer = postgres(url.toString(), { max: 1, connect_timeout: 2,
              connection: { default_transaction_read_only: "on", statement_timeout: 2000 } });
            try {
              const relations = lock[1]!.split(",").map(name => name.trim());
              const rows = await observer`SELECT clock_timestamp()::text AS sampled_at, pg_backend_pid() AS observer_pid, locks.*
                FROM (SELECT 1) sample LEFT JOIN (
                  SELECT l.pid, n.nspname || '.' || c.relname AS relation, l.mode, l.granted,
                    a.backend_type, a.state, a.xact_start::text, a.wait_event_type, a.wait_event,
                    substring(a.query FROM '^[[:space:]]*([[:alpha:]]+)') || ' [redacted]' AS query
                  FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
                  LEFT JOIN pg_stat_activity a ON a.pid=l.pid
                  WHERE l.locktype='relation' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
                    AND n.nspname=current_schema() AND c.relname IN ${observer(relations)}
                ) locks ON true ORDER BY relation,pid,mode`;
              const locks = rows.filter(row => row.relation !== null).map(row => ({ pid: row.pid, relation: row.relation, mode: row.mode, granted: row.granted,
                candidate: row.pid !== requester.pid && row.granted && !["AccessShareLock", "RowShareLock"].includes(row.mode),
                backend_type: row.backend_type, state: row.state, xact_start: row.xact_start,
                wait_event_type: row.wait_event_type, wait_event: row.wait_event, query: row.query }));
              const snapshot: LockSnapshot = { requester, failed_at: failedAt, sampled_at: rows[0]?.sampled_at ?? new Date().toISOString(),
                observer_pid: rows[0]!.observer_pid, requested_query: text, requested_mode: "ShareRowExclusiveLock",
                failed_relation: /could not obtain lock on relation "([a-z_]+)"/.exec(error.message ?? "")?.[1] ?? null,
                elapsed_ms: Date.now() - started, locks,
                visibility: "Same test database/current schema only; activity visibility follows observer privileges. Post-failure, non-atomic sample; no NOWAIT wait row required. Activity queries retain command only.",
                holder_assessment: locks.some(row => row.candidate)
                  ? "Incompatible granted lock candidates at sample time only; not proven holders at failure time."
                  : "Unknown: no visible incompatible granted lock at sample time; holder may already have released.",
              };
              snapshots.push(snapshot);
              console.error("[reserved-lock-diagnostic]", JSON.stringify(snapshot));
            } finally { await observer.end({ timeout: 2 }); }
          } catch (diagnosticError) {
            // Evidence collection/close failure must remain visible without
            // replacing the original 55P03 or printing URLs/error messages.
            console.error("[reserved-lock-diagnostic-failed]", JSON.stringify({ requester, failed_at: failedAt,
              code: (diagnosticError as { code?: string } | null)?.code ?? "unknown", elapsed_ms: Date.now() - started }));
          }
        }
        throw error;
      });
      return new Proxy(query, {
        get(original, key, receiver) {
          if (key === "then") return (...args: Parameters<Promise<unknown>["then"]>) => observe().then(...args);
          if (key === "catch") return (...args: Parameters<Promise<unknown>["catch"]>) => observe().catch(...args);
          if (key === "finally") return (...args: Parameters<Promise<unknown>["finally"]>) => observe().finally(...args);
          return Reflect.get(original, key, receiver);
        },
      });
    },
  }) as Sql;
}
async function effects() {
  const db = f.sql, scope = f.scope;
  return {
    private: await db`SELECT * FROM opening_course_reserved_questions WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    attempts: await db`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    exposures: await db`SELECT * FROM opening_course_question_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    coverage: await db`SELECT * FROM opening_course_question_exposure_coverage WHERE workspace_id=${scope.workspaceId}`,
    history: await db`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`,
    jobs: await db`SELECT * FROM opening_jobs WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
    budget: await db`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`,
  };
}
const assertNoScanner = (queries: string[]) => {
  expect(queries.some(query => /LOCK TABLE|pg_trigger|covered_surface_count|INSERT INTO opening_course_question_exposures|UPDATE opening_course_question_exposure_coverage/.test(query))).toBe(false);
};
it.each(["opening_learning_observations", "opening_teaching_activities"] as const)("production route matrix stays off scanner/exposure writes under %s maintenance", async table => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  // Keep the direct readiness assertion; production unknown is a separate policy.
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "ready", available: 1 });
  const before = await effects(), queries: string[] = [], sql = observedSql(f.sql, queries);
  const route = createOpeningCourseRouteRepository(sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests({ ...runtime, sql: observedSql(runtime.sql, queries) });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const holder = f.sql.begin(async tx => { await tx`LOCK TABLE ${tx(table)} IN SHARE UPDATE EXCLUSIVE MODE`; entered(); await held; });
  try {
    await Promise.race([ready, holder.then(() => { throw new Error("maintenance exited before release"); })]);
    const response = await getRoute(new Request(`http://localhost/api/opening/courses/${x.courseId}/learning-route`, {
      headers: { cookie: f.cookie },
    }), { params: Promise.resolve({ id: x.courseId }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requirements[0].reservedSupply).toEqual({ status: "unknown", available: 0, reason: "保留题曝光资格暂未接入生产供给" });
    const replay = await route.confirm(f.scope, x.courseId, { expectedRevisions: [], requirements: [x.definition], confirmScope: true });
    expect(replay.requirements[0]!.requirement.revision).toBe(1);
    expect(await effects()).toEqual(before);
    // Actual read-only transaction: no scanner writes permitted by PG either.
    expect(await createOpeningCourseRouteVerificationRepository(sql).read(f.scope, x.courseId, x.activityId)).toMatchObject({ available: false, items: [] });
    const start = await route.start(f.scope, x.courseId, { goalId: x.goal.id, expectedGoalRevision: 1,
      requirementId: x.requirement.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
    expect(start).toMatchObject({ kind: "ready", resumed: true, activity: { id: x.activityId } });
    const snapshot = await route.read(f.scope, x.courseId, x.activityId);
    expect(await route.next(f.scope, x.courseId, { goalId: x.goal.id, expectedGoalRevision: 1, activityId: x.activityId,
      expectedPathVersion: snapshot.currentActivity!.pathVersion, observationId: null, clientKey: randomUUID(), minutes: 20 })).toMatchObject({ kind: "choice", reason: "evidence_unknown" });
    await expect(createOpeningCourseRouteRetestRepository(sql).schedule(f.scope, x.courseId, { goalId: x.goal.id, expectedGoalRevision: 1,
      activityId: x.activityId, expectedPathVersion: snapshot.currentActivity!.pathVersion, observationId: randomUUID(), clientKey: randomUUID(), minutes: 10 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const maintenanceGoal = { ...x.goal, lifecycle: "maintenance" as const, maintenanceIntervalDays: 7 };
    const suggestions = await buildLongTermSuggestions(sql, f.scope, { date: "2026-11-08", timeZone: "UTC", now: new Date("2026-11-08T12:00:00Z"),
      goals: [maintenanceGoal], tasks: [], exactVerificationEnabled: true });
    expect(suggestions.suggestions.some(row => row.courseId === x.courseId && row.key.includes(":maintenance:"))).toBe(true);
    expect(await effects()).toEqual(before);
    const changed = await route.confirm(f.scope, x.courseId, { expectedRevisions: [{ id: x.requirement.id, revision: 1 }],
      requirements: [{ ...x.definition, title: "Arithmetic revised" }], confirmScope: true });
    expect(changed.requirements[0]!.requirement).toMatchObject({ revision: 2, title: "Arithmetic revised" });
    expect(await effects()).toEqual(before);
    assertNoScanner(queries);
    expect(queries.some(query => query.includes("UPDATE course_requirements"))).toBe(true);
  } finally { release(); await holder; setAuthRuntimeForTests(null); await runtime.close(); }
});
it("default pending init rejects with HTTP 409 and no consumption, while ownership precedes its SELECT", async () => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  await f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" }));
  const before = await effects(), queries: string[] = [], sql = observedSql(f.sql, queries);
  await expect(createOpeningTeachingContentService(sql).getClientInit(f.scope, x.activityId))
    .rejects.toMatchObject({ status: 409, code: "CONFLICT", message: "保留题曝光资格暂未接入生产供给" });
  for (const [scope, activityId] of [[f.otherScope, x.activityId], [f.scope, randomUUID()],
    [{ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, x.activityId]] as const) {
    const start = queries.length;
    await expect(createOpeningTeachingContentRepository(sql).getClientInit(scope, activityId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(queries.slice(start).some(query => query.includes("opening_course_reserved_questions"))).toBe(false);
  }
  expect(await effects()).toEqual(before);
  assertNoScanner(queries);
  expect(queries.some(query => /FOR UPDATE|INSERT INTO|UPDATE /.test(query))).toBe(false);
});
it("ordinary saved handout and card variant replay do not consume available private inventory", async () => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  const content = createOpeningTeachingContentRepository(f.sql);
  for (const card of [false, true]) {
    const activityId = await insertTestTeachingActivity(f.sql, f.scope, x.courseId);
    if (card) await f.sql`UPDATE opening_teaching_activities SET create_intent=${f.sql.json({ kind: "card_review_variant", cardId: randomUUID() })} WHERE id=${activityId}`;
    const blockId = randomUUID(), keyId = randomUUID();
    const blocks = [{ id: blockId, type: "prompt", content: { text: "2+3" } }, { id: keyId, type: "answer_key", content: { text: "5" } }];
    const unit = await content.createUnit(f.scope, { title: card ? "Card variant" : "Handout", blocks });
    await content.publishActivitySpec(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1,
      blockOrder: blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, role: block.type as "prompt" | "answer_key", position })) });
    const before = await effects(), queries: string[] = [], repository = createOpeningTeachingContentRepository(observedSql(f.sql, queries));
    const init = await repository.getClientInit(f.scope, activityId);
    expect(init?.blocks[0]?.content).toEqual({ text: "2+3" });
    expect(init?.blocks[1]).toMatchObject({ content: null, answerRef: { revealState: "hidden" } });
    expect(await repository.getClientInit(f.scope, activityId)).toEqual(init);
    expect(await effects()).toEqual(before); assertNoScanner(queries);
    expect(queries.some(query => /FOR UPDATE|INSERT INTO|UPDATE /.test(query))).toBe(false);
  }
});
it.each([
  ["137*19", "Example: 137 · 19"], ["$137*19$", "137*19"], ["137*19", "$137*19$"],
  ["\\(137 \\times 19\\)", "137*19"],
  ["$137*19 = ?$", "137*19"], ["137*19", "$137*19 = ?$"],
])("real consumer never reserves exposed alias %s from %s", async (text, history) => {
  const x = await setup(), sql = lockDiagnosedSql(f.sql);
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, text }), admitAndPersist: x.admit });
  expect(await readOpeningReservedSupply(sql, f.scope, x.requirement)).toMatchObject({ status: "ready", available: 1 });
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,${history})`;
  expect(await readCourseQuestionExposure(sql, f.scope, { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
    text, interaction: candidate.interaction, familyId: "arithmetic:*" })).toMatchObject({ coverage: "complete", exactExposed: true });
  expect(await readOpeningReservedSupply(sql, f.scope, x.requirement)).toMatchObject({ status: "missing", available: 0 });
  await expect(sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId} AND state<>'available'`).toHaveLength(0);
});
it("alias lock diagnostics sample a controlled holder without replacing 55P03", async () => {
  const x = await setup(), snapshots: LockSnapshot[] = [], sql = lockDiagnosedSql(f.sql, snapshots);
  let entered!: () => void, release!: () => void, holderPid = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  // Bound this artificial holder even if sampling fails; never delay alias success paths.
  const deadline = setTimeout(() => release(), 5000);
  const holder = f.sql.begin(async tx => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    holderPid = backend!.pid;
    await tx`SELECT id FROM library_blocks LIMIT 0`;
    await tx`LOCK TABLE library_blocks IN SHARE ROW EXCLUSIVE MODE`;
    entered(); await held;
  });
  try {
    await Promise.race([ready, holder.then(() => { throw new Error("diagnostic holder exited before release"); })]);
    await expect(readCourseQuestionExposure(sql, f.scope, { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
      text: candidate.text, interaction: candidate.interaction, familyId: "arithmetic:*" })).rejects.toMatchObject({ code: "55P03" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.locks).toEqual(expect.arrayContaining([expect.objectContaining({ pid: holderPid,
      relation: "public.library_blocks", mode: "ShareRowExclusiveLock", granted: true, candidate: true }),
      expect.objectContaining({ pid: holderPid, relation: "public.library_blocks", mode: "AccessShareLock", granted: true, candidate: false })]));
    expect(snapshots[0]!.failed_relation).toBe("library_blocks");
    expect(snapshots[0]!.requester.pid).not.toBe(holderPid);
    expect(snapshots[0]!.observer_pid).not.toBe(snapshots[0]!.requester.pid);
    expect(snapshots[0]!.observer_pid).not.toBe(holderPid);
  } finally { release(); clearTimeout(deadline); await holder; }
}, 10000);
it.each(["opening_learning_observations", "opening_teaching_activities"] as const)("fails closed while %s has a real maintenance lock", async table => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  const input = { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
    text: candidate.text, interaction: candidate.interaction, familyId: "arithmetic:*" };
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const holder = f.sql.begin(async tx => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE UPDATE EXCLUSIVE MODE`;
    entered(); await held;
  });
  try {
    await Promise.race([ready, holder.then(() => { throw new Error("maintenance barrier exited before release"); })]);
    await expect(readCourseQuestionExposure(f.sql, f.scope, input)).rejects.toMatchObject({ code: "55P03" });
    await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
      .rejects.toMatchObject({ code: "55P03" });
    expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId} AND state<>'available'`).toHaveLength(0);
  } finally { release(); await holder; }
});
it.each(["Example: 137 · 19 +", "137*19 if x>0", "See (137+2)*19 in figure", "Example: x+1"])("keeps unresolved history unknown with zero reservation: %s", async history => {
  const x = await setup(), sql = lockDiagnosedSql(f.sql);
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,${history})`;
  expect(await readOpeningReservedSupply(sql, f.scope, x.requirement)).toMatchObject({ status: "unknown", available: 0 });
  await expect(sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId} AND state<>'available'`).toHaveLength(0);
});
it("does not launder a legacy incomplete descriptor through a successful current rescan", async () => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  // Actual old grammar's output for Example: 137 · 19. Original history remains
  // present for a real rescan; the immutable legacy omission must still fail closed.
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,'Example: 137 · 19')`;
  await f.sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'legacy-middle-dot','teaching',
      ${f.sql.json({ complete: true, expressions: [], families: [] })},'{}',0)`;
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "unknown", available: 0 });
  const [legacy] = await f.sql`SELECT exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND surface_key='legacy-middle-dot'`;
  expect(legacy!.exact_content).toEqual({ complete: true, expressions: [], families: [] });
  await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects the original private pin after purpose changes back without inserting a candidate", async () => {
  const x = await setup();
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await f.sql`UPDATE course_asset_memberships SET purpose=NULL,updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("rejects a purpose writer committed before the admission pin lock", async () => {
  const x = await setup();
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(x.admit({ ...x.input, ...candidate })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("holds original purpose locks until candidate INSERT commit, using PG writer barriers", async () => {
  const x = await setup();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  // Delegate every statement to real PG. Hold the real transaction AFTER its
  // INSERT has completed but BEFORE begin commits, not just inside the pin callback.
  const commitBarrierSql = new Proxy(f.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (run: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await run(tx);
      expect(await tx`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
      entered(); await held;
      return result;
    });
  } });
  const admission = admitOpeningReservedCandidate(commitBarrierSql, f.scope, x.activityId, x.input, candidate, x.admission);
  await ready;
  try {
    expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    await expect(f.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
        AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await admission; }
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
    AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
});
it("fails closed without the server-only admission capability, including the legacy batch API", async () => {
  const x = await setup();
  const { saveOpeningReservedCandidates } = await import("../../packages/database/src/repositories/opening-course-reserved-selection");
  // Runtime calls can omit a required TypeScript parameter; neither public entry may bypass it.
  // @ts-expect-error intentionally missing server-only capability
  await expect(admitOpeningReservedCandidate(f.sql, f.scope, x.activityId, x.input, candidate)).rejects.toMatchObject({ code: "CONFLICT" });
  // @ts-expect-error intentionally missing server-only capability
  await expect(saveOpeningReservedCandidates(f.sql, f.scope, x.activityId, [candidate])).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("generates into authoritative private admission, never a public block/config/backup", async () => {
  const x = await setup();
  const result = await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  expect(result.kind).toBe("persisted");
  if (result.kind !== "persisted") throw new Error("private candidate not persisted");
  const [row] = await f.sql`SELECT * FROM opening_course_reserved_questions WHERE id=${result.privateRefId}`;
  expect(row).toMatchObject({ state: "available", question_json: { text: candidate.text }, key_json: { answer: candidate.answer },
    identity_json: { reservedQuestionId: result.privateRefId, requirementId: x.requirement.id, requirementRevision: 1, familyId: "arithmetic:*" } });
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  const backup = await readOpeningBackupRecords(f.sql, f.scope);
  expect(JSON.stringify(backup)).not.toContain(candidate.text); assertNoPrivateAnswer(backup, candidate.answer);
  expect(JSON.stringify(result)).not.toContain(candidate.answer);
});
it("rejects a plausible wrong key and concurrent generation admits only one exact question", async () => {
  const x = await setup();
  expect(await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, answer: "1" }), admitAndPersist: x.admit }))
    .toEqual({ kind: "unavailable", reason: "not_admitted" });
  const results = await Promise.all([1, 2].map(() => produceReservedQuestion(x.input, {
    generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit,
  })));
  expect(results.filter(row => row.kind === "persisted")).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
});
it("proves real generated supply through coverage, racing reservation, issued owner and first presentation", async () => {
  const x = await setup();
  const result = await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  expect(result.kind).toBe("persisted");
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "ready", available: 1 });
  const other = await insertTestTeachingActivity(f.sql, f.scope, x.courseId);
  await f.sql`UPDATE opening_teaching_activities SET goal_json=(SELECT goal_json FROM opening_teaching_activities WHERE id=${x.activityId}),
    source_ids=ARRAY[${x.sourceId}]::uuid[] WHERE id=${other}`;
  const reservations = await Promise.allSettled([x.activityId, other].map(activityId => f.sql.begin(tx =>
    reserveOpeningCourseQuestion(tx, f.scope, x.requirement, activityId, { kind: "new_question" }))));
  expect(reservations.filter(row => row.status === "fulfilled")).toHaveLength(1);
  const [reserved] = await f.sql`SELECT id,reserved_activity_id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`;
  const activityId = String(reserved!.reserved_activity_id);
  await expect(f.sql.begin(async tx => { await issueOpeningReservedQuestion(tx, f.scope, activityId); throw new Error("after issue"); }))
    .rejects.toThrow("after issue");
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND kind='presented'`).toHaveLength(0);
  // Production containment does not consume even genuinely ready inventory.
  const production = createOpeningTeachingContentRepository(f.sql);
  await expect(production.getClientInit(f.scope, activityId)).rejects.toMatchObject({
    code: "CONFLICT", message: "保留题曝光资格暂未接入生产供给",
  });
  expect(await f.sql`SELECT state FROM opening_course_reserved_questions WHERE id=${reserved!.id}`).toEqual([{ state: "reserved" }]);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND kind='presented'`).toHaveLength(0);
  // Explicit trusted capability still exercises the REAL scanner, not complete=true.
  const content = createOpeningTeachingContentRepository(f.sql, { readExposure: readCourseQuestionExposure });
  const [one, two] = await Promise.all([content.getClientInit(f.scope, activityId), content.getClientInit(f.scope, activityId)]);
  expect(one?.blocks).toEqual(two?.blocks); expect(one?.blocks).toHaveLength(1);
  expect(one?.blocks[0]?.content).toMatchObject({ text: candidate.text });
  expect(await production.getClientInit(f.scope, activityId)).toEqual(one);
  expect(JSON.stringify(one)).not.toContain(candidate.answer);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  const [issued] = await f.sql`SELECT state,issued_item_version_id FROM opening_course_reserved_questions WHERE id=${reserved!.id}`;
  expect(issued).toMatchObject({ state: "issued" }); expect(issued!.issued_item_version_id).toBeTruthy();
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}
    AND item_version_id=${issued!.issued_item_version_id} AND kind='presented'`).toHaveLength(1);
  expect(await readCourseQuestionExposure(f.sql, f.scope, { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
    text: "计算 137 × 19", interaction: candidate.interaction, familyId: "arithmetic:*" }))
    .toMatchObject({ coverage: "complete", exactExposed: true, familyExposed: true });
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, text: "139*23", answer: "3197" }), admitAndPersist: x.admit });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement, { kind: "same_family", familyId: "arithmetic:*" }))
    .toMatchObject({ status: "ready", available: 1 });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement, { kind: "new_family", excludedFamilyIds: [] }))
    .toMatchObject({ status: "missing", available: 0 });
  assertNoPrivateAnswer(await readOpeningBackupRecords(f.sql, f.scope), candidate.answer);
});

it("runs server-only pinned authority inside the original publication transaction before any spec writes", async () => {
  const x = await setup(), content = createOpeningTeachingContentRepository(f.sql), blockId = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  const error = Object.assign(new Error("original purpose pin changed"), { code: "CONFLICT" });
  let checked = false;
  await expect(content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id,
    expectedVersion: 0, revisionNumber: 1, blockOrder: [{ blockId, position: 0, role: "teach", blockType: "text" }] }, undefined,
  async tx => {
    checked = true;
    await tx`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'pinned-context-test','teaching','{}','{}',0)`;
    throw error;
  })).rejects.toBe(error);
  expect(checked).toBe(true);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND surface_key='pinned-context-test'`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(0);
});
it("rejects changed-back purpose using the original compiler pin in the actual publication transaction", async () => {
  const x = await setup(), purposes = createOpeningCourseReadySourcesRepository(f.sql), content = createOpeningTeachingContentRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: x.activityId, sourceIds: [x.sourceId], materialUse: "teaching" });
  const blockId = randomUUID(), unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await f.sql`UPDATE course_asset_memberships SET purpose=NULL,updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: 1, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }] }, undefined,
    tx => purposes.assertSourcePurposePin(f.scope, pin, tx))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(0);
});
it("holds the original purpose pin through actual publication, preventing a concurrent classification change", async () => {
  const x = await setup(), purposes = createOpeningCourseReadySourcesRepository(f.sql), content = createOpeningTeachingContentRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: x.activityId, sourceIds: [x.sourceId], materialUse: "teaching" });
  const blockId = randomUUID(), unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const publication = content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: 1, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }], sourceRefs: [{ sourceId: x.sourceId, version: 1 }] }, undefined,
  async tx => { await purposes.assertSourcePurposePin(f.scope, pin, tx); entered(); await held; });
  await ready;
  try {
    await expect(f.sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
        AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await publication; }
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(1);
});
it("uses the actual compiler/retriever caller and publishes with the original server purpose pin", async () => {
  const x = await setup();
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 10000 }),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
  const providerInput = await deps.buildProviderInput!(f.scope, payload);
  expect(providerInput.chunks).toHaveLength(1);
  expect(providerInput.chunks[0]!.sourceId).toBe(x.sourceId);
  const unit = await deps.ensureTeachingUnitId!(f.scope, payload);
  const hints = { direction: "Use the operation.", concept: "Rational arithmetic.", firstStep: "Multiply the numbers." };
  const output = { text: JSON.stringify({ blocks: [
    { type: "text", text: "Arithmetic operations on rational numbers.", citedChunkIds: [providerInput.chunks[0]!.id] },
    { type: "prompt", text: "2+3", interaction: { kind: "numeric" } },
    { type: "answer_key", text: "5", hints, ...rankPedagogy },
    { type: "prompt", text: "3+4", interaction: { kind: "numeric" } },
    { type: "answer_key", text: "7", hints, ...rankPedagogy },
  ] }), citedChunkIds: [], requestId: "fake-provider-fixture", candidates: [], inputTokens: 1, outputTokens: 1 };
  const publish = await deps.buildPublishInput!(f.scope, { ...payload, teachingUnitId: unit }, output, providerInput);
  expect(JSON.stringify(publish)).not.toContain("purposeRevision");
  const teachingUnit = await createOpeningTeachingContentRepository(f.sql).getUnit(f.scope, unit);
  const [before] = await f.sql`SELECT current_revision_number FROM library_documents WHERE id=${teachingUnit!.documentId}`;
  expect(Number(before!.current_revision_number)).toBe(1);
  expect(await f.sql`SELECT id FROM library_blocks WHERE document_id=${teachingUnit!.documentId} AND content->>'text'='draft'`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${teachingUnit!.documentId}`).toHaveLength(1);
  await deps.publishActivitySpec(f.scope, publish);
  const [revision] = await f.sql`SELECT id FROM library_revisions WHERE document_id=${teachingUnit!.documentId} AND revision_number=2`;
  expect(revision!.id).toBeTruthy();
  const graph = JSON.stringify(await f.sql`SELECT * FROM library_revisions WHERE document_id=${teachingUnit!.documentId} ORDER BY revision_number`);
  await deps.publishActivitySpec(f.scope, publish);
  await deps.publishActivitySpec(f.scope, { ...publish, expectedVersion: 1, verificationStatus: "structure_ok" });
  expect(JSON.stringify(await f.sql`SELECT * FROM library_revisions WHERE document_id=${teachingUnit!.documentId} ORDER BY revision_number`)).toBe(graph);
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(1);
  await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(deps.publishActivitySpec(f.scope, { ...publish, expectedVersion: 1, verificationStatus: "structure_ok" }))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects a changed purpose between the actual compiler input and public block construction", async () => {
  const x = await setup();
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 10000 }),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
  const input = await deps.buildProviderInput!(f.scope, payload);
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(deps.buildPublishInput!(f.scope, { ...payload, teachingUnitId: randomUUID() }, null, input))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("runs only public compilation through the production worker and real budget ledger without private generation or replay resend", async () => {
  const x = await setup(), requests: string[] = [];
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const bytes of request) body.push(Buffer.from(bytes));
    const raw = Buffer.concat(body).toString("utf8"); requests.push(raw);
    const source = x.chunkId;
    const hints = { direction: "Use operations.", concept: "Rational arithmetic.", firstStep: "Add the numbers." };
    const output = { blocks: [
      { type: "text", text: "Arithmetic operations on rational numbers.", citedChunkIds: source ? [source] : [] },
      { type: "prompt", text: "2+3", interaction: { kind: "numeric" } },
      { type: "answer_key", text: "5", hints, ...rankPedagogy },
      { type: "prompt", text: "3+4", interaction: { kind: "numeric" } },
      { type: "answer_key", text: "7", hints, ...rankPedagogy },
    ] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fake-reserved",
      choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [name, value] of Object.entries({ OPENING_TEACHING_COMPILER_ENABLED: "1", OPENING_TEACHING_VALIDATION_ENABLED: "0",
      OPENING_PROVIDER_ALLOW_LOCAL: "1", OPENING_MODEL_API_KEY: "test-private-generation", OPENING_MODEL_DEFAULT_ID: "reserved-fixture",
      OPENING_MODEL_DAILY_CAP_CENTS: "100000", OPENING_MODEL_CATALOG: JSON.stringify([{ id: "reserved-fixture", label: "Fixture",
        providerId: "fixture", providerLabel: "Fixture", modelName: "fixture", apiKeyEnv: "OPENING_MODEL_API_KEY",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }]) })) vi.stubEnv(name, value);
    const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
    const job = { id: randomUUID(), workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId, key: randomUUID(), kind: "compile-teaching-unit",
      payload, result: null, state: "running" as const, privacyEpoch: 0 };
    await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES(${job.id},${f.scope.workspaceId},${f.scope.ownerUserId},${job.key},${job.kind},${f.sql.json(payload)},'running')`;
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100000 }),
      chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
    const handler = createCompileTeachingUnitHandler(deps);
    expect(await handler(job, payload)).toMatchObject({ generateStatus: "needs_check" });
    expect(requests).toHaveLength(1);
    const rows = await f.sql`SELECT question_json,key_json FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`;
    expect(rows).toHaveLength(0);
    const revisions = JSON.stringify(await f.sql`SELECT blocks FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`);
    expect(revisions).not.toContain(candidate.text); expect(revisions).not.toContain(candidate.answer);
    const budget = await f.sql`SELECT state,result_ref FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId} ORDER BY request_id`;
    expect(budget).toHaveLength(1); expect(budget.every(row => row.state === "completed")).toBe(true);
    expect(budget.some(row => String(row.result_ref).startsWith("reserved-generation:"))).toBe(false);
    expect(await handler(job, payload)).toMatchObject({ replayed: true }); expect(requests).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(JSON.stringify(await f.sql`SELECT blocks FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`)).toBe(revisions);
    expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    assertNoPrivateAnswer(await readOpeningBackupRecords(f.sql, f.scope), candidate.answer);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it("keeps production supply unknown while direct unsupported inventory stays missing and mastery unknown", async () => {
  const x = await setup();
  await f.sql`UPDATE course_requirements SET requirement_key='rank',verification=${f.sql.json({ kind: "rubric", status: "ready",
    exerciseKeys: ["rank"], rubric: "Explain rank", missingReasons: [] })} WHERE id=${x.requirement.id}`;
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  const snapshot = await route.read(f.scope, x.courseId), item = snapshot.requirements[0]!;
  expect(await readOpeningReservedSupply(f.sql, f.scope, item.requirement)).toMatchObject({ status: "missing", available: 0 });
  expect(item.reservedSupply).toEqual({ status: "unknown", available: 0, reason: "保留题曝光资格暂未接入生产供给" });
  expect(item.questionCoverage).toEqual({ savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" });
  expect(snapshot.summary.verified).toBe(0);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("revalidates pinned source/requirement versions after generation and leaves no half write", async () => {
  const x = await setup();
  await expect(produceReservedQuestion(x.input, { generate: async () => {
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
    return JSON.stringify(candidate);
  }, admitAndPersist: x.admit })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
