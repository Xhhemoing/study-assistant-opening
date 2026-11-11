import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExperimentalBktSnapshotService } from "../../apps/web/src/lib/experimental-bkt-snapshot-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { seedFiveActivation } from "./opening-experimental-bkt-five-activation-fixture";
import { seedIncrementalDiagnostic, type IncrementalDiagnostic } from "./opening-experimental-bkt-incremental-diagnostic-fixture";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });
async function evidence(name: string, value: unknown) {
  if (process.env.BKT_DIAGNOSTIC_OUTPUT_DIR) {
    await writeFile(path.join(process.env.BKT_DIAGNOSTIC_OUTPUT_DIR, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  }
}
function assertIndependent(f: IncrementalDiagnostic, state: Awaited<ReturnType<IncrementalDiagnostic["inspect"]>>) {
  expect(f.heads.every(h => h.observation.verdictSource === "deterministic" && h.observation.outcome === "correct")).toBe(true);
  expect(new Set(f.heads.map(h => h.attempt.problemId)).size).toBe(f.heads.length);
  expect(state.projected).toHaveLength(f.heads.length);
  expect(state.projected.every(p => p.independent_attempt === "yes" && p.verified_correct === "yes"
    && p.usable_for_current_version === "yes" && p.reason_codes.includes("deterministic_correct"))).toBe(true);
}
function assertFallback(state: Awaited<ReturnType<IncrementalDiagnostic["inspect"]>>, samples: number) {
  expect(state.snapshot.features).toHaveLength(samples);
  expect(state.port).toMatchObject({ comparisonReady: false, reason: "insufficient_samples",
    port: { status: "fallback", reason: "insufficient_samples", experimentalAdvice: null,
      ruleDecision: { activityKind: "transfer_check", reasonCode: "independent" } } });
}

describe("Opus395 nonblocking usability diagnostic: real incremental writer and current course help", () => {
  it("sequential five natural-time writes retain positive eligibility but only latest revision can enter snapshot; approved batch fixture can compare", async () => {
    const f = await seedIncrementalDiagnostic(fixture), stages = [];
    for (let index = 0; index < 5; index++) {
      await f.submit(index);
      const state = await f.inspect();
      stages.push(state);
      assertIndependent(f, state);
      expect(state.projected.filter(p => String(p.input_revision) === state.revision)).toHaveLength(1);
      expect(state.snapshot.status).toBe("available");
      expect(state.snapshot.observationHeads.map(h => h.id)).toEqual([f.heads[index]!.observation.id]);
      expect(state.snapshot.excluded.qualification_unavailable ?? 0).toBe(index);
      expect(state.live.every(row => row.has_course_help === false)).toBe(true);
      assertFallback(state, 1);
    }
    // Explicit control on its OWN workspace: inherited fixture intentionally
    // retimes facts and batch-refreshes all five. Never repairs the natural path.
    const batchFixture = await createOpeningFixture();
    try {
      const batch = await seedFiveActivation(batchFixture);
      const snapshot = await batch.repository.read(batch.scope, batch.input);
      const output = await createExperimentalBktSnapshotService({ host: batch.host, repository: batch.repository }).readPort({ enabled: true });
      expect(snapshot.features).toHaveLength(5);
      expect(new Set(snapshot.families.map(row => row.familyId)).size).toBe(3);
      expect(output).toMatchObject({ comparisonReady: true, reason: "compared",
        port: { status: "compared", experimentalAdvice: { kind: "continue_rule" } } });
      await evidence("incremental-vs-approved-batch", { stages, batch: { snapshot, output },
        interpretation: "conservative revision admission; not production/auth/mastery evidence" });
    } finally { await batchFixture.close(); }
  });

  it("one later help on another problem in same course excludes all five current course heads, including the fresh post-help independent head", async () => {
    const f = await seedIncrementalDiagnostic(fixture);
    for (let index = 0; index < 4; index++) await f.submit(index);
    const before = await f.inspect(), help = await f.help(true), afterHelp = await f.inspect();
    assertIndependent(f, afterHelp);
    expect(afterHelp.live).toHaveLength(4);
    expect(afterHelp.live.every(row => row.has_course_help === true)).toBe(true);
    expect(afterHelp.projected.every(p => String(p.input_revision) !== afterHelp.revision)).toBe(true);
    expect(afterHelp.snapshot.excluded).toEqual({ qualification_unavailable: 4 });
    expect(afterHelp.snapshot.reason).toBe("no_qualified_heads");
    // A fresh different problem separates course-help denial from old revision denial.
    await f.submit(4);
    const afterNewHead = await f.inspect();
    assertIndependent(f, afterNewHead);
    expect(afterNewHead.live).toHaveLength(5);
    expect(afterNewHead.live.every(row => row.has_course_help === true)).toBe(true);
    expect(afterNewHead.snapshot.excluded).toEqual({ qualification_unavailable: 4, non_independent_or_unknown: 1 });
    expect(afterNewHead.snapshot.reason).toBe("no_qualified_heads");
    expect(afterNewHead.snapshot.features).toHaveLength(0);
    expect(afterNewHead.port).toEqual({ comparisonReady: false, reason: "snapshot:no_qualified_heads", port: null });
    await evidence("same-course-one-help", { before, help, afterHelp, afterNewHead });
  });

  it("one help in another course still advances workspace revision, but does not taint a fresh current course independent head", async () => {
    const f = await seedIncrementalDiagnostic(fixture);
    for (let index = 0; index < 4; index++) await f.submit(index);
    const before = await f.inspect(), help = await f.help(false), afterHelp = await f.inspect();
    assertIndependent(f, afterHelp);
    expect(afterHelp.live.every(row => row.has_course_help === false)).toBe(true);
    expect(afterHelp.snapshot.excluded).toEqual({ qualification_unavailable: 4 });
    await f.submit(4);
    const afterNewHead = await f.inspect();
    assertIndependent(f, afterNewHead);
    expect(afterNewHead.live).toHaveLength(5);
    expect(afterNewHead.live.every(row => row.has_course_help === false)).toBe(true);
    expect(afterNewHead.snapshot.excluded).toEqual({ qualification_unavailable: 4 });
    expect(afterNewHead.snapshot.observationHeads.map(h => h.id)).toEqual([f.heads[4]!.observation.id]);
    assertFallback(afterNewHead, 1);
    await evidence("other-course-one-help", { before, help, afterHelp, afterNewHead });
  });
});
