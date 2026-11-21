import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";
const hooks = vi.hoisted(() => ({ release: vi.fn(), lock: vi.fn(), readAttempt: vi.fn() }));
vi.mock("./opening-study-exposure", async original => ({ ...await original<typeof import("./opening-study-exposure")>(), releaseOpeningStudyExposure: hooks.release }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(), lockWorkspaceLearningHistory: hooks.lock }));
vi.mock("./opening-tutor-attempt-context", async original => ({ ...await original<typeof import("./opening-tutor-attempt-context")>(), readTutorAttemptContext: hooks.readAttempt }));
vi.mock("./opening-context-provenance", async original => ({ ...await original<typeof import("./opening-context-provenance")>(), contextSourceRefsIncluded: () => "synthetic-admission-expression" }));
const workspace = "12000000-0000-4000-8000-000000000001", owner = "12000000-0000-4000-8000-000000000002";
const jobId = "12000000-0000-4000-8000-000000000003", assistant = "12000000-0000-4000-8000-000000000004";
const user = "12000000-0000-4000-8000-000000000005", receipt = "12000000-0000-4000-8000-000000000006";
const token = "12000000-0000-4000-8000-000000000007", execution = "12000000-0000-4000-8000-000000000008";
const attempt = "12000000-0000-4000-8000-000000000009", item = "12000000-0000-4000-8000-000000000010";
const courseId = "12000000-0000-4000-8000-000000000011", sourceId = "12000000-0000-4000-8000-000000000012";
const membershipId = "12000000-0000-4000-8000-000000000013", purposeRevision = "2026-11-20T00:00:00.000000Z";
const fence = { attemptId: attempt, itemVersionId: item, rootObservationId: null, headObservationId: null, answerRevision: null };
const pin = { courseId, materialUse: "citation" as const, sources: [{ sourceId, sourceVersion: 0, membershipId, purposeRevision, purpose: "teaching" as const }] };
const scope = { workspaceId: workspace, ownerUserId: owner }, time = "2026-11-10T00:00:00.000Z";
const context = { privacyEpoch: 2, contextSourceRefs: [], exposureReceiptId: receipt, claimToken: token, executionId: execution };
const job = { id: jobId, workspace_id: workspace, conversation_id: "conversation", user_turn_id: user, assistant_turn_id: assistant,
  status: "running", mode: "hint", error: null, created_at: time, updated_at: time, claim_token: token, timing_execution_id: execution,
  attempt_id: null, context_anchor: null, source_ids: [] as string[], course_id: null as string | null };
type Options = { missingWorkspace?: boolean; missingJob?: boolean; status?: string; epoch?: number; token?: string; execution?: string;
  unavailableSource?: boolean; missingExposure?: boolean; failAt?: string; boundAttempt?: string; anchorAttempt?: string;
  courseId?: string | null; sourceIds?: string[]; membershipRemoved?: boolean; archivedCourse?: boolean };
function fixture(options: Options = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []; const failure = new Error(`synthetic ${options.failAt}`);
  const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    if (!sql.startsWith("SELECT")) return "fragment";
    calls.push({ sql, values });
    if (options.failAt && sql.startsWith(options.failAt)) throw failure;
    if (sql.startsWith("SELECT privacy_epoch")) return options.missingWorkspace ? [] : [{ privacy_epoch: options.epoch ?? 2 }];
    if (sql.startsWith("SELECT j.*,t.attempt_id") || sql.startsWith("SELECT j.user_turn_id,t.attempt_id")) {
      return options.missingJob ? [] : [{ ...job, status: options.status ?? "running", claim_token: options.token ?? token, timing_execution_id: options.execution ?? execution,
        attempt_id: options.boundAttempt ?? null, context_anchor: options.anchorAttempt ? { attemptId: options.anchorAttempt } : null,
        source_ids: options.sourceIds ?? [], course_id: options.courseId ?? null }];
    }
    if (sql.startsWith("SELECT id FROM workspaces")) return options.missingWorkspace ? [] : [{ id: workspace }];
    if (sql.startsWith("SELECT id FROM courses")) return options.archivedCourse ? [] : [{ id: options.courseId ?? courseId }];
    if (sql.startsWith("SELECT s.id,s.version FROM opening_sources")) return options.unavailableSource ? [] : [{ id: sourceId, version: 0 }];
    if (sql.startsWith("SELECT id,asset_id,purpose")) {
      return options.membershipRemoved ? [] : [{ id: membershipId, asset_id: sourceId, purpose: "teaching", purpose_revision: purposeRevision }];
    }
    if (sql.startsWith("SELECT source_id FROM opening_privacy_exclusions")) return [];
    if (sql.startsWith("SELECT 1 WHERE")) return options.unavailableSource ? [] : [{ "?column?": 1 }];
    if (sql.startsWith("SELECT id FROM opening_help_exposures")) return options.missingExposure ? [] : [{ id: receipt }];
    throw new Error(`Unsupported fixture query: ${sql}`);
  }), { json: (value: unknown) => value });
  const sql = Object.assign(vi.fn(), { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) });
  return { repo: createOpeningTutorJobsRepository(sql as unknown as Sql), tx, calls, failure };
}
beforeEach(() => { vi.resetAllMocks(); hooks.lock.mockResolvedValue(undefined); hooks.release.mockResolvedValue({ id: receipt });
  hooks.readAttempt.mockResolvedValue({ anchor: { attemptId: attempt, itemVersionId: item }, rootObservationId: null, headObservationId: null, currentAnswer: null }); });
// SQL rows and material admission are preset; no database authorization is proven.
describe("stream receipt release waits for current job authorization and assistant-turn binding", () => {
  it("releases the exact assistant receipt after admitted job and before returning running status", async () => {
    const f = fixture(); const out = await f.repo.readStream(scope, jobId, context);
    expect(out).toMatchObject({ id: jobId, assistantTurnId: assistant, status: "running" });
    expect(hooks.lock).toHaveBeenCalledExactlyOnceWith(f.tx, scope);
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(f.tx, scope, receipt);
    const exposure = f.calls.find(c => c.sql.startsWith("SELECT id FROM opening_help_exposures"))!;
    // Deliberately strict full statement: preserve every constraint and reject
    // appended OR clauses. Equivalent SQL rewrites may require updating this test.
    expect(exposure.sql).toBe("SELECT id FROM opening_help_exposures WHERE id=? AND workspace_id=? AND owner_user_id=? AND turn_id=? AND exposure_origin='assistant'");
    expect(exposure.values).toEqual([receipt, workspace, owner, assistant]);
    expect(f.calls.map(c => c.sql.split(" ").slice(0, 2).join(" "))).toEqual(["SELECT privacy_epoch", "SELECT j.*,t.attempt_id,t.context_anchor,t.source_ids,c.course_id", "SELECT 1", "SELECT id"]);
  });
  it("waits for receipt release before resolving a running stream authorization", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<unknown>(resolve => { finish = resolve; });
    hooks.release.mockImplementationOnce(() => { entered(); return pending; });
    let returned = false;
    const call = f.repo.readStream(scope, jobId, context).then(value => { returned = true; return value; });
    const settled = call.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      const arrival = await Promise.race([reached.then(() => ({ entered: true as const })), settled.then(result => ({ entered: false as const, result }))]);
      if (!arrival.entered && !arrival.result.ok) throw arrival.result.error;
      expect(arrival.entered, "stream must enter receipt release before returning").toBe(true);
      expect(returned).toBe(false);
    } finally { finish?.({ id: receipt }); await settled; }
    expect(await call).toMatchObject({ id: jobId, status: "running" });
  });
  it("accepts no receipt without inventing a release or exposure lookup", async () => {
    const f = fixture(); expect(await f.repo.readStream(scope, jobId, { ...context, exposureReceiptId: null })).toMatchObject({ status: "running" });
    expect(hooks.release).not.toHaveBeenCalled(); expect(f.calls.some(c => c.sql.startsWith("SELECT id FROM opening_help_exposures"))).toBe(false);
  });
  it.each(["complete", "cancelled", "failed", "outcome_unknown"])("terminal %s does not authorize a new release", async status => {
    const f = fixture({ status }); expect(await f.repo.readStream(scope, jobId, context)).toMatchObject({ status });
    expect(hooks.release).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(2);
  });
  it.each(["missingWorkspace", "missingJob"] as const)("returns null without releasing when %s", async missing => {
    const f = fixture({ [missing]: true }); expect(await f.repo.readStream(scope, jobId, context)).toBeNull();
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it.each([
    { label: "privacy epoch", options: { epoch: 3 }, message: "stream authorization changed" },
    { label: "claim token", options: { token: owner }, message: "stream authorization changed" },
    { label: "execution identity", options: { execution: owner }, message: "stream execution changed" },
    { label: "source unavailable", options: { unavailableSource: true }, message: "stream material unavailable or excluded" },
    { label: "foreign/missing receipt row", options: { missingExposure: true }, message: "stream exposure does not belong to assistant turn" },
  ])("rejects $label before release", async ({ options, message }) => {
    const f = fixture(options);
    await expect(f.repo.readStream(scope, jobId, context)).rejects.toThrow(message);
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it.each(["SELECT privacy_epoch", "SELECT j.*,t.attempt_id", "SELECT 1 WHERE", "SELECT id FROM opening_help_exposures"])("propagates %s read failure before release", async failAt => {
    const f = fixture({ failAt }); await expect(f.repo.readStream(scope, jobId, context)).rejects.toBe(f.failure);
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it.each([{ label: "column", options: { boundAttempt: attempt } }, { label: "saved anchor", options: { anchorAttempt: attempt } }])(
    "requires current attempt fence for $label binding before release", async ({ options }) => {
      const f = fixture(options);
      expect(await f.repo.readStream(scope, jobId, { ...context, attemptFence: fence })).toMatchObject({ status: "running" });
      expect(hooks.readAttempt).toHaveBeenCalledExactlyOnceWith(f.tx, scope, { jobId, userTurnId: user, claimToken: token });
      expect(hooks.release).toHaveBeenCalledOnce();
    });
  it.each([
    { label: "missing fence", value: undefined }, { label: "invalid fence", value: { ...fence, answerRevision: true } },
  ])("rejects $label before attempting provenance or release", async ({ value }) => {
    const f = fixture({ boundAttempt: attempt });
    await expect(f.repo.readStream(scope, jobId, { ...context, attemptFence: value as unknown as typeof fence })).rejects.toThrow("stream attempt fence missing");
    expect(hooks.readAttempt).not.toHaveBeenCalled(); expect(hooks.release).not.toHaveBeenCalled();
  });
  it("rejects a supplied fence without a server-bound attempt", async () => {
    const f = fixture(); await expect(f.repo.readStream(scope, jobId, { ...context, attemptFence: fence })).rejects.toThrow("stream attempt fence missing");
    expect(hooks.readAttempt).not.toHaveBeenCalled(); expect(hooks.release).not.toHaveBeenCalled();
  });
  it.each(["missing", "changed"] as const)("rejects %s current attempt snapshot without releasing", async outcome => {
    const f = fixture({ boundAttempt: attempt });
    if (outcome === "missing") hooks.readAttempt.mockResolvedValueOnce(null);
    else hooks.readAttempt.mockResolvedValueOnce({ anchor: { attemptId: attempt, itemVersionId: owner }, rootObservationId: null, headObservationId: null, currentAnswer: null });
    await expect(f.repo.readStream(scope, jobId, { ...context, attemptFence: fence })).rejects.toThrow("stream attempt context changed");
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it("propagates durable release failure instead of returning a running job", async () => {
    const f = fixture(), failure = new Error("synthetic release failure"); hooks.release.mockRejectedValueOnce(failure);
    await expect(f.repo.readStream(scope, jobId, context)).rejects.toBe(failure);
    expect(hooks.release).toHaveBeenCalledOnce();
  });
  it("verifies materialPurposePin and course membership inside both withStreamPublication and readStream", async () => {
    const valid = fixture({ courseId, sourceIds: [sourceId] });
    const publish = vi.fn(async () => {});
    await valid.repo.withStreamPublication(scope, jobId, { ...context, materialPurposePin: pin }, publish);
    expect(publish).toHaveBeenCalledOnce();
    expect(await valid.repo.readStream(scope, jobId, { ...context, materialPurposePin: pin })).toMatchObject({ status: "running" });
    expect(hooks.release).toHaveBeenCalledOnce();

    hooks.release.mockClear();
    const removed = fixture({ courseId, sourceIds: [sourceId], membershipRemoved: true });
    const blockedPublish = vi.fn(async () => {});
    await expect(removed.repo.withStreamPublication(scope, jobId, { ...context, materialPurposePin: pin }, blockedPublish))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(blockedPublish).not.toHaveBeenCalled();
    await expect(removed.repo.readStream(scope, jobId, { ...context, materialPurposePin: pin }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it.each([
    { label: "missing pin", value: undefined, message: "stream material purpose pin missing" },
    { label: "invalid pin", value: { ...pin, materialUse: "bad" }, message: "stream material purpose pin invalid" },
    { label: "mismatched course", value: { ...pin, courseId: null }, message: "stream material purpose pin mismatch" },
    { label: "mismatched use", value: { ...pin, materialUse: "practice" }, message: "stream material purpose pin mismatch" },
    { label: "incomplete sources", value: { ...pin, sources: [] }, message: "stream material purpose pin incomplete" },
  ])("rejects $label before publish or exposure release", async ({ value, message }) => {
    const f = fixture({ courseId, sourceIds: [sourceId] });
    const publish = vi.fn(async () => {});
    await expect(f.repo.withStreamPublication(scope, jobId, { ...context, materialPurposePin: value as unknown as typeof pin }, publish))
      .rejects.toThrow(message);
    expect(publish).not.toHaveBeenCalled();
    await expect(f.repo.readStream(scope, jobId, { ...context, materialPurposePin: value as unknown as typeof pin }))
      .rejects.toThrow(message);
    expect(hooks.release).not.toHaveBeenCalled();
  });
});
