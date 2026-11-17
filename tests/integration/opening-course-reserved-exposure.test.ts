import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { readCourseQuestionExposure, recordCourseQuestionExposure, refreshCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const question = () => ({ reservedQuestionId: randomUUID(), identityRefId: randomUUID(), courseId: randomUUID(),
  requirementId: randomUUID(), requirementRevision: 1, sourceVersions: {}, text: "137*19",
  interaction: { kind: "numeric" as const }, familyId: "arithmetic:*" });
// Transparent forwarding only: every observed statement executes on real PG.
function observe(db: Sql | TransactionSql, queries: string[], after?: (query: string) => Promise<void>): Sql {
  return new Proxy(db, {
    apply(target, receiver, args) {
      const query = Array.isArray(args[0]) && "raw" in args[0] ? args[0].join("?") : null;
      const result = Reflect.apply(target, receiver, args);
      if (!query) return result;
      queries.push(query);
      return Promise.resolve(result).then(async rows => { await after?.(query); return rows; });
    },
    get(target, key, receiver) {
      if (key === "begin") return (...args: unknown[]) => (target as Sql).begin(
        ...(args.slice(0, -1) as []),
        tx => (args.at(-1) as (tx: TransactionSql) => Promise<unknown>)(observe(tx, queries, after) as unknown as TransactionSql),
      );
      return Reflect.get(target, key, receiver);
    },
  }) as Sql;
}
it("requires DB genesis plus a real scan and cannot retrofit unknown historical coverage", async () => {
  const [genesis] = await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  expect(genesis).toMatchObject({ complete: false, invalidated: false });
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "complete", exactExposed: false });
  await f.sql`DELETE FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,complete,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'course-question-exposure-1',0,true,0)`).rejects.toMatchObject({ code: "23514" });
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it.each(["missing", "invalidated"] as const)("rejects %s origin before history and maintenance locks without exposure writes", async state => {
  if (state === "missing") await f.sql`DELETE FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  else await f.sql`UPDATE opening_course_question_exposure_coverage SET invalidated=true WHERE workspace_id=${f.scope.workspaceId}`;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const holder = f.sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, f.scope);
    await tx`LOCK TABLE opening_learning_observations,opening_teaching_activities IN SHARE UPDATE EXCLUSIVE MODE`;
    entered(); await held;
  });
  const queries: string[] = [];
  try {
    await Promise.race([ready, holder.then(() => { throw new Error("holder exited before release"); })]);
    await f.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout='200ms'`;
      expect(await refreshCourseQuestionExposure(observe(tx, queries) as unknown as TransactionSql, f.scope)).toBe(false);
    });
    expect(await readCourseQuestionExposure(observe(f.sql, queries), f.scope, question())).toMatchObject({ coverage: "unknown" });
    expect(queries.some(query => /FOR UPDATE|LOCK TABLE|INSERT INTO|UPDATE opening_course_question_exposure_coverage/.test(query))).toBe(false);
    expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    // Preserve the exact original workspace error, before the coverage probe.
    for (const scope of [{ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, { ...f.scope, workspaceId: randomUUID() }]) {
      const rejected: string[] = [];
      await expect(readCourseQuestionExposure(observe(f.sql, rejected), scope, question()))
        .rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
      expect(rejected).toHaveLength(1);
    }
  } finally { release(); await holder; }
});
it.each(["invalidate", "descriptor"] as const)("rechecks a real %s committed after the candidate probe", async change => {
  const queries: string[] = [];
  let probed = false;
  const sql = observe(f.sql, queries, async query => {
    if (probed || !query.includes("SELECT invalidated FROM opening_course_question_exposure_coverage\n")) return;
    probed = true;
    if (change === "invalidate") await f.sql`UPDATE opening_course_question_exposure_coverage SET invalidated=true WHERE workspace_id=${f.scope.workspaceId}`;
    else await f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, {
      surfaceKey: "probe-race", kind: "presented", text: "137*19", sourceVersions: {},
    }));
  });
  expect(await readCourseQuestionExposure(sql, f.scope, question())).toMatchObject(change === "invalidate"
    ? { coverage: "unknown" } : { coverage: "complete", exactExposed: true, familyExposed: true });
  expect(probed).toBe(true);
  expect(queries.some(query => query.includes("LOCK TABLE"))).toBe(true);
  expect(queries.some(query => query.includes("protocol=") && query.includes("FOR UPDATE"))).toBe(true);
  if (change === "invalidate") {
    expect(queries.some(query => query.includes("pg_trigger") || query.includes("INSERT INTO opening_course_question_exposures"))).toBe(false);
    expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  }
});
it("retains descriptor insertion fencing after the locked origin recheck", async () => {
  let checked = false;
  const sql = observe(f.sql, [], async query => {
    if (checked || !query.includes("SELECT invalidated FROM opening_course_question_exposure_coverage c")) return;
    checked = true;
    await expect(f.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout='100ms'`;
      await recordCourseQuestionExposure(tx, f.scope, { surfaceKey: "locked-race", kind: "presented", text: "137*19", sourceVersions: {} });
    })).rejects.toMatchObject({ code: "55P03" });
  });
  expect(await readCourseQuestionExposure(sql, f.scope, question())).toMatchObject({ coverage: "complete", exactExposed: false });
  expect(checked).toBe(true);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND surface_key='locked-race'`).toHaveLength(0);
});
it("persists a presentation before answer, keeps replay idempotent and rolls back failed writes", async () => {
  const input = { surfaceKey: "presented:question", kind: "presented" as const, text: "137*19", sourceVersions: {} };
  await Promise.all([1, 2].map(() => f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, input))));
  const rows = await f.sql`SELECT kind,exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "presented", exact_content: { complete: true, expressions: ["137*19"], families: ["arithmetic:*"] } });
  await expect(f.sql.begin(async tx => {
    await recordCourseQuestionExposure(tx, f.scope, { ...input, surfaceKey: "failed", kind: "hint" });
    throw new Error("presentation failed");
  })).rejects.toThrow("presentation failed");
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "complete", exactExposed: true });
  await expect(f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, { ...input, text: "139*23" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("scans examples, hints, unanswered prompts and retained old source versions", async () => {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source(), chunkId = randomUUID();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'Example: 137*19')`;
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${sourceId},2,1,'Current rational arithmetic lesson.')`;
  const conversation = await rows.conversation();
  await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
    VALUES(${randomUUID()},${f.scope.workspaceId},${conversation},'assistant','Hint: 139*23','hint','complete','{}','{}')`;
  const documentId = randomUUID();
  await f.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number)
    VALUES(${documentId},${f.scope.workspaceId},'Practice','published',1)`;
  await f.sql`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,title,lifecycle,reason,blocks)
    VALUES(${randomUUID()},${f.scope.workspaceId},${documentId},1,'Practice','published','test',
      ${f.sql.json([{ id: randomUUID(), type: "prompt", position: 0, content: { text: "141*29" } }])})`;
  for (const text of ["计算 137 × 19", "139*23", "141*29"]) {
    expect(await readCourseQuestionExposure(f.sql, f.scope, { ...question(), text }))
      .toMatchObject({ coverage: "complete", exactExposed: true, familyExposed: true });
  }
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  await f.sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it.each([["137*19", "+137*19"], ["+137*19", "137*19"], ["1*2", "1*+2"], ["1*+2", "1*2"]])(
  "scans a real genesis source %s as exposed to %s", async (exposed, candidate) => {
    const [genesis] = await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
    expect(genesis).toMatchObject({ complete: false, invalidated: false });
    const sourceId = await backupRows(f.sql, f.scope).source();
    await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
      VALUES(${randomUUID()},${sourceId},1,1,${`Hint: ${exposed}`})`;
    expect(await readCourseQuestionExposure(f.sql, f.scope, { ...question(), text: candidate }))
      .toMatchObject({ coverage: "complete", exactExposed: true, familyExposed: true });
    const [descriptor] = await f.sql`SELECT kind,exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`;
    expect(descriptor).toMatchObject({ kind: "teaching", exact_content: { grammar: "reserved-arithmetic-3", complete: true,
      expressions: [candidate.startsWith("1*") ? "1*2" : "137*19"], families: ["arithmetic:*"] } });
    expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });
it.each([[], ["137*19"], ["+137*19"]].map(expressions => ({ expressions })))("keeps immutable v2 descriptor $expressions unknown after a real rescan", async ({ expressions }) => {
  const sourceId = await backupRows(f.sql, f.scope).source();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${sourceId},1,1,'Example: +137*19')`;
  const id = randomUUID(), old = { grammar: "reserved-arithmetic-2", complete: true, expressions, families: ["arithmetic:*+"] };
  // Historical input only: ordinary INSERT, no coverage writes or disabled guards.
  await f.sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
    VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},'legacy-v2','teaching',${f.sql.json(old)},'{}',0)`;
  for (const text of ["137*19", "+137*19"]) {
    expect(await readCourseQuestionExposure(f.sql, f.scope, { ...question(), text }))
      .toMatchObject({ coverage: "unknown", exactExposed: false, familyExposed: false });
  }
  const [retained] = await f.sql`SELECT exact_content FROM opening_course_question_exposures WHERE id=${id}`;
  expect(retained!.exact_content).toEqual(old);
  const current = await f.sql`SELECT exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND id<>${id}`;
  expect(current).toHaveLength(1);
  expect(current[0]!.exact_content).toMatchObject({ grammar: "reserved-arithmetic-3", complete: true, expressions: ["137*19"] });
  const [coverage] = await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  expect(coverage).toMatchObject({ complete: false, invalidated: false });
});
it("rolls back unary-plus exposure and scanner coverage together", async () => {
  await expect(f.sql.begin(async tx => {
    await recordCourseQuestionExposure(tx, f.scope, { surfaceKey: "rolled-back-alias", kind: "hint", text: "+137*19", sourceVersions: {} });
    expect(await readCourseQuestionExposure(tx, f.scope, question()))
      .toMatchObject({ coverage: "complete", exactExposed: true, familyExposed: true });
    throw new Error("rollback alias exposure");
  })).rejects.toThrow("rollback alias exposure");
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  const [coverage] = await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  expect(coverage).toMatchObject({ complete: false, invalidated: false });
  expect(await readCourseQuestionExposure(f.sql, f.scope, { ...question(), text: "+137*19" }))
    .toMatchObject({ coverage: "complete", exactExposed: false, familyExposed: false });
});
it("never promotes partial extraction or unknown old history to unseen", async () => {
  await f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, { surfaceKey: "unparsed", kind: "example",
    body: { text: "See (137+2)*19 in figure", imageObjectKey: "figure" }, sourceVersions: {} }));
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("rejects a scan immediately when a concurrent surface writer already owns its table", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const writer = f.sql.begin(async tx => {
    await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
    entered(); await held;
  });
  await ready;
  try { await expect(readCourseQuestionExposure(f.sql, f.scope, question())).rejects.toMatchObject({ code: "55P03" }); }
  finally { release(); await writer; }
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "complete", exactExposed: true });
});
it("holds every surface fence through the scanner transaction, releasing it on rollback", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const scanner = f.sql.begin(async tx => { expect(await refreshCourseQuestionExposure(tx, f.scope)).toBe(true); entered(); await held; });
  await ready;
  try {
    await expect(f.sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
        VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await scanner; }
  await f.sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "complete", exactExposed: true });
});
