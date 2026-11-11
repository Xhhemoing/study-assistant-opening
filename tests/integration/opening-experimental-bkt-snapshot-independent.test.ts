import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { listMigrationFiles } from "../../packages/database/src/migrate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository, openingExperimentalBktHeadsQuery,
  openingExperimentalBktHeldOutQuery, type ExperimentalBktSnapshotInput } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

// Run only against the task's disposable PG cluster via the existing integration
// globalSetup (real migrations 0001–0111). No HTTP, fake SQL or projection injection.
// These are current MVCC reads with evidence-time cutoffs, NOT historical replay.
let fixture: OpeningFixture;
const cutoff = "2026-11-10T12:00:00.000Z";
const submitted = "2026-11-10T10:00:00.000Z";
const recorded = "2026-11-10T10:01:00.000Z";
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

async function seed() {
  const sql = fixture.sql, scope = fixture.scope;
  const rows = backupRows(sql, scope);
  const sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${scope.workspaceId},'Independent BKT PG',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const start = (problemId: string) => attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId, version: 1 } });
  const target = await start("span-example-2d");
  const heads: Array<{ attempt: LearningAttempt; observation: LearningObservation }> = [];
  // Two distinct catalogue problems in one family, plus a distinct-family positive
  // control. Wrong deterministic answers qualify as independent incorrect evidence.
  for (const catalogueId of ["span-independent-3d", "span-reserved-20261021-q03", "span-reserved-20261021-q02"]) {
    const attempt = await start(catalogueId);
    const observation = await learning.insertObservation(scope, { sessionId: session.id, courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients: ["99", "99"],
        equation: attempt.spanExercise, coordinateChecks: attempt.spanExercise!.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    expect(observation.verdictSource).toBe("deterministic");
    expect(observation.outcome).toBe("incorrect");
    heads.push({ attempt, observation });
  }
  // Fixture-only timestamp control, not qualification fabrication. Refresh below
  // computes real persisted eligibility using the production evidence evaluator.
  await sql`UPDATE opening_learning_item_versions SET created_at='2026-11-10T08:00:00Z' WHERE course_id=${courseId}`;
  await sql`UPDATE opening_learning_attempts SET started_at='2026-11-10T09:00:00Z',
    submitted_at=CASE WHEN observation_id IS NULL THEN NULL ELSE ${submitted}::timestamptz END WHERE course_id=${courseId}`;
  await sql`UPDATE opening_learning_observations SET started_at='2026-11-10T09:00:00Z',
    submitted_at=${submitted},recorded_at=${recorded} WHERE course_id=${courseId}`;
  const refresh = () => sql.begin(tx => refreshOpeningLearningEligibility(tx, scope, heads.map(h => h.observation.id)));
  await refresh();
  const input: ExperimentalBktSnapshotInput = { courseId, requirementKey: SPAN_REQUIREMENT_KEY,
    problemId: target.problemId!, itemVersionId: target.itemVersionId!, cutoff };
  const read = (patch: Partial<ExperimentalBktSnapshotInput> = {}) =>
    createOpeningExperimentalBktSnapshotRepository(sql).read(scope, { ...input, ...patch });
  return { sql, scope, courseId, sourceId, target, heads, input, read, refresh };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function assertPositive(f: Seed) {
  const result = await f.read();
  // Zero eligible is deliberately a failure, never evidence that exclusion works.
  console.info("BKT_REAL_PG_POSITIVE", JSON.stringify({ status: result.status, reason: result.reason,
    eligible: result.features.length, excluded: result.excluded }));
  expect(result.status, JSON.stringify(result)).toBe("available");
  expect(result.observationHeads.map(h => h.id).sort()).toEqual(f.heads.map(h => h.observation.id).sort());
  expect(result.families.map(family => family.familyId).sort()).toEqual([
    "span:consistent-3d", "span:inconsistent-3d", "span:inconsistent-3d",
  ]);
  return result;
}

describe("card 1 — real migration/schema and metadata SQL", () => {
  it("has every real migration with verified checksums and preserves revision immutability", async () => {
    const files = await listMigrationFiles();
    expect(files).toContain("0001_library.sql");
    expect(files).toContain("0111_opening_explicit_regrade_requests.sql");
    const expected = files.map(id => ({
      id,
      checksum: createHash("sha256").update(readFileSync(
        new URL(`../../packages/database/src/migrations/${id}`, import.meta.url), "utf8",
      )).digest("hex"),
      verification_state: "verified",
    }));
    const rows = await fixture.sql`SELECT id,checksum,verification_state FROM schema_migrations ORDER BY id`;
    expect(rows).toHaveLength(files.length);
    expect([...rows]).toEqual(expected);
    const guards = await fixture.sql`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='library_revisions'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(guards).toEqual(expect.arrayContaining([
      expect.objectContaining({ tgname: "library_revisions_no_update", tgenabled: "O" }),
      expect.objectContaining({ tgname: "library_revisions_no_delete", tgenabled: "O" }),
    ]));
  });
  it("executes both exported SQL queries on real PG in readonly repeatable read, then admits nonzero evidence", async () => {
    const f = await seed();
    await f.sql.begin("isolation level repeatable read read only", async tx => {
      const [settings] = await tx`SELECT current_setting('transaction_read_only') AS ro,
        current_setting('transaction_isolation') AS isolation`;
      expect(settings).toEqual({ ro: "on", isolation: "repeatable read" });
      const bindings = await openingExperimentalBktHeldOutQuery(tx, f.scope, {
        ...f.input, excludedProblemIds: [f.heads[0]!.observation.id],
      });
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ held_out_id: f.heads[0]!.observation.id, resolver_current: true });
      const heads = await openingExperimentalBktHeadsQuery(tx, f.scope, f.input);
      expect(heads).toHaveLength(3);
      console.info("BKT_REAL_PG_QUALIFICATION", JSON.stringify(heads.map(h => ({ id: h.id,
        head_revision: h.head_revision, input_revision: h.input_revision, independent: h.independent_attempt,
        verified: h.verified_correct, usable: h.usable_for_current_version, reasons: h.reason_codes,
        source_current: h.sources_current, item_current: h.item_current }))));
      for (const row of [...bindings, ...heads]) {
        for (const key of ["answer", "stem_snapshot", "evaluation_spec", "ai_evaluation", "server_evaluation", "text"]) {
          expect(row).not.toHaveProperty(key);
        }
      }
    });
    await assertPositive(f);
  });
});

describe("card 2 — actual scope, dual time and held-out-family controls", () => {
  it("rejects foreign owner/workspace/course and cannot resolve foreign held-out IDs", async () => {
    const f = await seed();
    await assertPositive(f);
    const repo = createOpeningExperimentalBktSnapshotRepository(f.sql);
    for (const scope of [fixture.otherScope, { ...f.scope, ownerUserId: fixture.otherScope.ownerUserId },
      { ...f.scope, workspaceId: fixture.otherScope.workspaceId }]) {
      expect(await repo.read(scope, f.input)).toMatchObject({ status: "not_available", features: [] });
      const bindings = await f.sql.begin("isolation level repeatable read read only", tx =>
        openingExperimentalBktHeldOutQuery(tx, scope, { ...f.input, excludedProblemIds: [f.heads[0]!.observation.id] }));
      expect(bindings).toHaveLength(0);
    }
    const otherCourse = randomUUID();
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
      VALUES (${otherCourse},${f.scope.workspaceId},'Other scoped course',${otherCourse})`;
    const bindings = await f.sql.begin("isolation level repeatable read read only", tx =>
      openingExperimentalBktHeldOutQuery(tx, f.scope, { ...f.input, courseId: otherCourse,
        excludedProblemIds: [f.heads[0]!.observation.id] }));
    expect(bindings).toHaveLength(0);
    expect(await f.read({ courseId: otherCourse })).toMatchObject({ status: "not_available", features: [] });
    expect(await f.read({ courseId: randomUUID() })).toMatchObject({ status: "not_available", features: [] });
    expect(await f.read({ excludedProblemIds: [randomUUID()] })).toMatchObject({
      status: "not_available", reason: "held_out_family_unavailable", features: [],
    });
  });
  it("enforces BOTH submitted and recorded strict cutoffs, including equality, without losing the positive control", async () => {
    const f = await seed();
    await assertPositive(f);
    const bad = f.heads[0]!, good = f.heads.slice(1).map(h => h.observation.id).sort();
    for (const [at, stored] of [[submitted, cutoff], [cutoff, cutoff], ["2026-11-10T13:00:00Z", "2026-11-10T13:01:00Z"],
      [recorded, submitted]]) {
      await f.sql`UPDATE opening_learning_observations SET submitted_at=${at!},recorded_at=${stored!} WHERE id=${bad.observation.id}`;
      await f.sql`UPDATE opening_learning_attempts SET submitted_at=${at!} WHERE id=${bad.attempt.id}`;
      const result = await f.read();
      expect(result.status).toBe("available");
      expect(result.observationHeads.map(h => h.id).sort()).toEqual(good);
      expect(result.excluded.dual_time_unavailable).toBe(1);
    }
    await f.sql`UPDATE opening_learning_observations SET submitted_at=${submitted},recorded_at=${recorded} WHERE id=${bad.observation.id}`;
    await f.sql`UPDATE opening_learning_attempts SET submitted_at=${submitted} WHERE id=${bad.attempt.id}`;
    await assertPositive(f);
  });
  it.each(["problem", "observation"] as const)("excludes both same-family siblings for a held-out %s UUID, not a distinct family", async form => {
    const f = await seed();
    await assertPositive(f);
    const held = f.heads[0]!, control = f.heads[2]!;
    const excludedId = form === "problem" ? held.attempt.problemId! : held.observation.id;
    const result = await f.read({ excludedProblemIds: [excludedId] });
    expect(result.status).toBe("available");
    expect(result.observationHeads.map(h => h.id)).toEqual([control.observation.id]);
    expect(result.excluded.held_out_or_target_family).toBe(2);
    expect(result.families).toEqual([{ observationId: control.observation.id,
      familyId: "span:consistent-3d", provenance: "span_catalogue" }]);
  });
  it("resolves a cross-requirement non-effective observation before excluding its sibling family", async () => {
    const f = await seed();
    await assertPositive(f);
    const held = f.heads[0]!, replacementRequirement = "independent-test:other-requirement";
    // Real append-only retraction leaves the original UUID non-effective. Imported
    // cross-requirement metadata must still retain its negative exposure identity.
    const retracted = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: held.observation.id, revisesObservationId: held.observation.id,
      expectedHead: held.observation.id, revisionKind: "retract", reason: "Independent held-out identity check",
      clientKey: randomUUID(),
    });
    expect(retracted.headObservationId).not.toBe(held.observation.id);
    await f.sql`UPDATE opening_learning_observations SET requirement_key=${replacementRequirement} WHERE id=${held.observation.id}`;
    await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,
      '{requirementKey}',${f.sql.json(replacementRequirement)}) WHERE id=${held.attempt.itemVersionId!}`;
    await f.refresh();
    const [old] = await f.sql`SELECT effective_head_id,revision_kind FROM opening_learning_observations WHERE id=${held.observation.id}`;
    expect(old).toMatchObject({ effective_head_id: retracted.headObservationId, revision_kind: "original" });
    const input = { ...f.input, excludedProblemIds: [held.observation.id] };
    const bindings = await f.sql.begin("isolation level repeatable read read only", tx => openingExperimentalBktHeldOutQuery(tx, f.scope, input));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ requirement_key: replacementRequirement, resolver_current: true });
    const result = await f.read({ excludedProblemIds: [held.observation.id] });
    expect(result.status).toBe("available");
    expect(result.observationHeads.map(h => h.id)).toEqual([f.heads[2]!.observation.id]);
    expect(result.excluded.held_out_or_target_family).toBe(1);
  });
  it("unknown/forged/null family or unresolved identity fails closed, with a prior nonzero control", async () => {
    const f = await seed();
    await assertPositive(f);
    const held = f.heads[0]!;
    const [original] = await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${held.attempt.itemVersionId!}`;
    for (const family of ["unknown:test-family", "span:consistent-3d", null]) {
      await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,
        '{familyId}',${f.sql.json(family)}) WHERE id=${held.attempt.itemVersionId!}`;
      expect(await f.read({ excludedProblemIds: [held.observation.id] })).toMatchObject({
        status: "not_available", reason: "held_out_family_unavailable", features: [],
      });
    }
    await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=${f.sql.json(original!.evaluation_spec)} WHERE id=${held.attempt.itemVersionId!}`;
    await assertPositive(f);
  });
});

// Thin instrumentation delegates EVERY tag/begin to the real driver. It never
// supplies rows or a fake transaction. The barrier is after the real context
// SELECT: a second real connection commits a source change before target/heads.
function instrument(sql: Sql, options: { afterContext?: () => Promise<void>; probeWrite?: boolean } = {}) {
  const order: string[] = [], snapshots: string[] = [];
  let readonlyViolation: string | undefined;
  const wrapped = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (mode: string, callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(mode, async tx => {
        expect(mode).toBe("isolation level repeatable read read only");
        const [start] = await tx`SELECT current_setting('transaction_read_only') AS ro,
          current_setting('transaction_isolation') AS isolation,txid_current_snapshot()::text AS snapshot`;
        expect(start).toMatchObject({ ro: "on", isolation: "repeatable read" });
        snapshots.push(String(start!.snapshot));
        if (options.probeWrite) {
          try {
            await tx.savepoint(async save => { await save`UPDATE workspaces SET privacy_epoch=privacy_epoch`; });
          } catch (error) {
            readonlyViolation = (error as { code?: string }).code;
          }
          expect(readonlyViolation).toBe("25006");
        }
        const traced = new Proxy(tx, {
          async apply(tag, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
            const query = args[0].join("?");
            const label = query.includes("clock_timestamp() AS data_as_of") ? "context"
              : query.includes("AS target_created_at") ? "target" : query.includes("WITH bindings AS") ? "heldout" : "heads";
            order.push(label);
            const rows = await Reflect.apply(tag, thisArg, args);
            const [state] = await tx`SELECT txid_current_snapshot()::text AS snapshot`;
            snapshots.push(String(state!.snapshot));
            if (label === "context") await options.afterContext?.();
            return rows;
          },
        });
        return callback(traced);
      });
    },
  });
  return { sql: wrapped, order, snapshots, violation: () => readonlyViolation };
}

describe("card 3 — real read-only constraint and one current MVCC snapshot", () => {
  it("PG rejects a write in the actual repository transaction and preserves sequential context/target/lookup/heads", async () => {
    const f = await seed();
    await assertPositive(f);
    const observed = instrument(f.sql, { probeWrite: true });
    const result = await createOpeningExperimentalBktSnapshotRepository(observed.sql).read(f.scope, {
      ...f.input, excludedProblemIds: [f.heads[0]!.observation.id],
    });
    expect(result.status).toBe("available");
    expect(result.features).toHaveLength(1);
    expect(observed.violation()).toBe("25006");
    expect(observed.order).toEqual(["context", "target", "heldout", "heads"]);
    expect(observed.snapshots).toHaveLength(5);
    expect(new Set(observed.snapshots).size).toBe(1);
  });
  it("a concurrent committed source update is invisible within the read but visible on the NEXT read (not historical replay)", async () => {
    const f = await seed();
    await assertPositive(f);
    const writer = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    try {
      const observed = instrument(f.sql, { afterContext: async () => {
        await writer`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
      } });
      const result = await createOpeningExperimentalBktSnapshotRepository(observed.sql).read(f.scope, f.input);
      expect(result.status).toBe("available");
      expect(result.features).toHaveLength(3);
      expect(observed.order).toEqual(["context", "target", "heads"]);
      expect(new Set(observed.snapshots).size).toBe(1);
      const next = await f.read();
      expect(next).toMatchObject({ status: "not_available", reason: "canonical_target_family_unavailable", features: [] });
      const [source] = await writer`SELECT version FROM opening_sources WHERE id=${f.sourceId}`;
      expect(source!.version).toBe(2);
      console.info("BKT_REAL_PG_MVCC", JSON.stringify({ during: result.features.length, next: next.reason,
        transactionSnapshots: observed.snapshots, currentMvccNotHistorical: true }));
    } finally { await writer.end({ timeout: 5 }); }
  });
});
