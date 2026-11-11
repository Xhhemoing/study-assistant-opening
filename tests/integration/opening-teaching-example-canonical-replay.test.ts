import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEACHING_COMMAND_LOG_MAX } from "@aistudy/contracts";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { canonicalExampleFixture, canonicalGraph, canonicalRollbackFault, compactReplaySnapshots } from "./opening-teaching-example-canonical-replay.fixture";

let f: OpeningFixture;
beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("HTTP/provider calls forbidden in canonical command lifecycle"); }));
  f = await createOpeningFixture();
});
afterAll(async () => { await f?.close(); vi.unstubAllGlobals(); });

describe("card1: canonical owned activity / first-publication help (real PG)", () => {
  it.each([false, true])("first example before any attempt retains question help, uppercase=%s", async uppercase => {
    const x = await canonicalExampleFixture(f);
    expect(await f.sql`SELECT a.id FROM opening_learning_attempts a JOIN opening_learning_sessions s ON s.id=a.session_id WHERE s.activity_id=${x.activity.id}`).toHaveLength(0);
    expect(await f.sql`SELECT id FROM opening_learning_item_versions WHERE activity_id=${x.activity.id}`).toHaveLength(0);
    const spelling = uppercase ? x.activity.id.toUpperCase() : x.activity.id;
    expect(spelling.toLowerCase()).toBe(x.activity.id);
    expect(await x.command(x.request, spelling)).toMatchObject({ ok: true, contentVersion: 2, revisionNumber: 2 });
    const receipts = await x.receipts();
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId,
        activity_id: x.activity.id, delivered: true, kind: "solution", level: "revealed",
        attempt_id: null, item_version_id: null, problem_id: null });
      expect(receipt.released_at).not.toBeNull();
      expect(receipt.context_anchor).toMatchObject({ activityId: x.activity.id, contentVersion: 2, purpose: "learning_help" });
    }
    const result = await x.qualify(2);
    console.log("CARD1_FIRST", JSON.stringify({ uppercase, activityId: x.activity.id, receipts, result }));
    expect(result.evidence.context.helpHistory?.complete).toBe(true);
    expect(result.evidence.context.helpHistory?.exposures.length).toBeGreaterThan(0);
    expect(result.observation.eligibility?.independentAttempt).toBe("no");
    expect(result.eligibility.independentAttempt).toBe("no");
    const frozen = await canonicalGraph(f);
    expect(await x.command(x.request, uppercase ? x.activity.id : x.activity.id.toUpperCase())).toMatchObject({ ok: true, replayed: true });
    expect(await canonicalGraph(f)).toEqual(frozen);
  });

  it.each([false, true])("cross-spelling unchanged rewrite carries help before first attempt, uppercase-first=%s", async uppercase => {
    const x = await canonicalExampleFixture(f);
    expect(await x.command(x.request, uppercase ? x.activity.id.toUpperCase() : x.activity.id)).toMatchObject({ ok: true });
    const before = await x.receipts();
    expect(await f.sql`SELECT a.id FROM opening_learning_attempts a JOIN opening_learning_sessions s ON s.id=a.session_id WHERE s.activity_id=${x.activity.id}`).toHaveLength(0);
    expect(await x.command({ ...x.request, kind: "rephrase", blockId: x.questionId, clientKey: `rewrite-${x.request.clientKey}`, expectedVersion: 2 },
      uppercase ? x.activity.id : x.activity.id.toUpperCase())).toMatchObject({ ok: true, contentVersion: 3, revisionNumber: 3 });
    const receipts = await x.receipts();
    expect(receipts).toHaveLength(3);
    expect(receipts.filter(r => before.some(old => old.id === r.id))).toEqual(before);
    const carried = receipts.find(r => !before.some(old => old.id === r.id));
    expect(carried).toMatchObject({ delivered: true, activity_id: x.activity.id,
      context_anchor: { activityId: x.activity.id, blockId: x.questionId, contentVersion: 3 } });
    const result = await x.qualify(3);
    console.log("CARD1_CARRY", JSON.stringify({ uppercase, receipts, result }));
    expect(result.evidence.context.helpHistory?.exposures.length).toBeGreaterThan(0);
    expect(result.eligibility.independentAttempt).toBe("no");
    expect(result.observation.eligibility?.independentAttempt).toBe("no");
  });
});

describe("card2: opaque client keys / durable replay after real ring rotation (PG)", () => {
  it.each([false, true])("200 Unicode client key survives eviction, question=%s", async withQuestion => {
    const x = await canonicalExampleFixture(f, withQuestion);
    const clientKey = "键".repeat(199) + "A";
    const request = { ...x.request, clientKey };
    expect(clientKey).toHaveLength(200);
    expect(await x.command(request, x.activity.id.toUpperCase())).toMatchObject({ ok: true, contentVersion: 2 });
    const first = await canonicalGraph(f);
    expect(await x.command(request)).toMatchObject({ ok: true, replayed: true });
    expect(await canonicalGraph(f)).toEqual(first);
    expect(await x.command({ ...request, expectedVersion: 2 })).toMatchObject({ ok: false, conflict: "client_key_intent_mismatch" });
    expect(await canonicalGraph(f)).toEqual(first);
    const generated = (await x.content.getClientInit(f.scope, x.activity.id))!.blocks.at(-1)!;
    expect(generated.content).toMatchObject({ workedExampleOf: { clientKey } });
    for (let i = 0; i < TEACHING_COMMAND_LOG_MAX; i++) {
      await compactReplaySnapshots(f, x.activity.id);
      // JSONB roundtrips object keys by byte length, then bytes, not insertion age.
      // Equal-byte-length keys greater than A rotate BOTH the log and replay map
      // via real commands; short keys would evict themselves from the map first.
      // Reserve suffix 'a' for the later case-sensitive new-operation assertion.
      const rotationKey = "键".repeat(199) + String.fromCharCode(66 + i + (i >= 31 ? 1 : 0));
      expect(rotationKey).not.toBe(clientKey.toLowerCase());
      expect(Buffer.byteLength(rotationKey)).toBe(Buffer.byteLength(clientKey));
      expect(await x.command({ kind: "why", clientKey: rotationKey, blockId: x.exampleId, expectedVersion: 2 })).toMatchObject({ ok: true });
    }
    const [saved] = await f.sql`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${x.activity.id}`;
    expect(saved!.checkpoint_json.commandLog).toHaveLength(TEACHING_COMMAND_LOG_MAX);
    expect(saved!.checkpoint_json.commandLog.some((e: { clientKey: string }) => e.clientKey === clientKey)).toBe(false);
    expect(saved!.checkpoint_json.commandReplay[clientKey]).toBeUndefined();
    expect(Object.keys(saved!.checkpoint_json.commandReplay)).toHaveLength(TEACHING_COMMAND_LOG_MAX);
    const frozen = await canonicalGraph(f);
    for (const expectedVersion of [1, 2]) for (const blockId of [x.exampleId, generated.blockId]) {
      expect(await x.command({ ...request, expectedVersion, blockId }, x.activity.id.toUpperCase())).toMatchObject({ ok: false, conflict: "validation" });
      expect(await canonicalGraph(f)).toEqual(frozen);
    }
    for (const scope of [f.otherScope, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }]) {
      await expect(createOpeningTeachingCommandService(f.sql).execute(scope, x.activity.id, request)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await canonicalGraph(f)).toEqual(frozen);
    }
    // Lowercasing the opaque key must be a genuinely new operation, not replay.
    expect(await x.command({ ...request, clientKey: clientKey.toLowerCase(), expectedVersion: 2 })).toMatchObject({ ok: true, replayed: false, contentVersion: 3 });
    expect(await x.receipts()).toHaveLength(withQuestion ? 4 : 2);
    expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${x.unit.documentId}`).toHaveLength(3);
    console.log("CARD2_ROTATION", JSON.stringify({ withQuestion, clientKey, logLength: saved!.checkpoint_json.commandLog.length, receipts: await x.receipts() }));
  }, 30000);

  it("same opaque key in another activity is not globally deduplicated; changed source is refused", async () => {
    const a = await canonicalExampleFixture(f), b = await canonicalExampleFixture(f);
    const clientKey = "activity-scoped-opaque-key";
    expect(await a.command({ ...a.request, clientKey })).toMatchObject({ ok: true });
    expect(await b.command({ ...b.request, clientKey })).toMatchObject({ ok: true, replayed: false });
    const keysA = (await a.receipts()).map(r => r.release_key), keysB = (await b.receipts()).map(r => r.release_key);
    expect(keysA.some(key => keysB.includes(key))).toBe(false);
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${b.sourceId}`;
    // Keep source admission valid so the command reaches the stale publication pin.
    await f.sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${b.chunkId}`;
    const frozen = await canonicalGraph(f);
    expect(await b.command({ ...b.request, clientKey: "changed-source-new-operation", expectedVersion: 2 })).toMatchObject({ ok: false, conflict: "stale_revision" });
    expect(await canonicalGraph(f)).toEqual(frozen);
  });
});

// Card1 above is frozen; these exercise additional boundaries on the same exact R8.
describe("card3: real PG transaction / CAS / original CHECK boundaries", () => {
  it("serializes different operations at one CAS and a concurrent duplicate delivery", async () => {
    const x = await canonicalExampleFixture(f);
    const results = await Promise.all([x.command(), x.command({ ...x.request, clientKey: `${x.request.clientKey}-other` })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toMatchObject([{ conflict: "stale_content_version" }]);
    expect(await x.receipts()).toHaveLength(2);
    expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${x.unit.documentId}`).toHaveLength(2);
    const y = await canonicalExampleFixture(f);
    const duplicates = await Promise.all([y.command(y.request, y.activity.id.toUpperCase()), y.command()]);
    expect(duplicates.every(r => r.ok)).toBe(true);
    expect(duplicates.filter(r => r.ok && r.replayed)).toHaveLength(1);
    expect(await y.receipts()).toHaveLength(2);
    expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${y.unit.documentId}`).toHaveLength(2);
  });

  it.each(["expectedVersion", "expectedPathVersion", "expectedRevisionNumber"] as const)("refuses stale %s without partial writes", async field => {
    const x = await canonicalExampleFixture(f);
    let expectedVersion = 1;
    if (field === "expectedPathVersion") {
      expect(await x.command({ kind: "skip", blockId: x.exampleId, clientKey: `advance-${x.request.clientKey}`, expectedVersion: 1 }))
        .toMatchObject({ ok: true, pathVersion: 2, contentVersion: 1 });
    } else if (field === "expectedRevisionNumber") {
      expect(await x.command({ kind: "rephrase", blockId: x.exampleId, clientKey: `advance-${x.request.clientKey}`, expectedVersion: 1 }))
        .toMatchObject({ ok: true, revisionNumber: 2, contentVersion: 2 });
      expectedVersion = 2;
    }
    const frozen = await canonicalGraph(f);
    const codes = { expectedVersion: "stale_content_version", expectedPathVersion: "stale_path_version", expectedRevisionNumber: "stale_revision" };
    expect(await x.command({ ...x.request, expectedVersion, [field]: field === "expectedVersion" ? 0 : 1 }))
      .toMatchObject({ ok: false, conflict: codes[field] });
    expect(await canonicalGraph(f)).toEqual(frozen);
  });

  it.each(["activity", "receipt"] as const)("rolls the complete graph back after a PG-side %s fault", async point => {
    const x = await canonicalExampleFixture(f);
    const frozen = await canonicalGraph(f);
    const remove = await canonicalRollbackFault(f, x.activity.id, point);
    try {
      await expect(x.command()).rejects.toMatchObject({ code: point === "activity" ? "CONFLICT" : "23514" });
      expect(await canonicalGraph(f)).toEqual(frozen);
    } finally { await remove(); }
    // A failed transaction did not consume the opaque operation key.
    expect(await x.command()).toMatchObject({ ok: true, replayed: false, contentVersion: 2 });
    expect(await x.receipts()).toHaveLength(2);
  });

  it("persists real emitted keys under the original PG CHECK and rolls invalid writes back", async () => {
    const x = await canonicalExampleFixture(f);
    expect(await x.command({ ...x.request, clientKey: "键".repeat(200) })).toMatchObject({ ok: true });
    const receipts = await x.receipts();
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) expect(receipt.release_key.length).toBeLessThanOrEqual(200);
    const [constraint] = await f.sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='opening_help_exposures'::regclass AND conname='opening_help_release_key_check'`;
    expect(constraint!.definition).toContain("char_length(release_key) >= 8");
    expect(constraint!.definition).toContain("char_length(release_key) <= 200");
    const frozen = await canonicalGraph(f);
    for (const releaseKey of ["", "x".repeat(7), "键".repeat(201)]) {
      await expect(f.sql.begin(async tx => {
        await tx`UPDATE opening_help_exposures SET release_key=${releaseKey} WHERE id=${receipts[0]!.id}`;
      })).rejects.toMatchObject({ code: "23514", constraint_name: "opening_help_release_key_check" });
      expect(await canonicalGraph(f)).toEqual(frozen);
    }
    expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });
});
