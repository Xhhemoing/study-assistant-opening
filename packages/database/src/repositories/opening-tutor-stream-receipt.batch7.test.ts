import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";
import { hasAttemptedFallbackStreamSeal, UnconfirmedStreamSealError } from "./opening-tutor-stream-fence";
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
type Options = { missingWorkspace?: boolean; missingJob?: boolean; status?: string; phase2Status?: string; epoch?: number; token?: string; execution?: string | null;
  unavailableSource?: boolean; missingExposure?: boolean; failAt?: string; failCommitAtTx?: number; boundAttempt?: string; anchorAttempt?: string;
  anchorSourceId?: string; courseId?: string | null; sourceIds?: string[]; sourceVersions?: Record<string, number>; membershipRemoved?: boolean; archivedCourse?: boolean; classifiedStandalone?: boolean;
  derivedMembershipPurpose?: "teaching" | "practice" | "mock_exam" | "reference" | null;
  activeGlobalMemoryIds?: string[]; backedMemorySourceIds?: string[]; mockExamSourceIds?: string[]; tutorStreamRedisUrl?: string };
function fixture(options: Options = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []; const failure = new Error(`synthetic ${options.failAt ?? "commit"}`);
  const txEvents: string[] = [];
  let txNumber = 0;
  const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    if (sql.startsWith("UPDATE opening_tutor_jobs SET timing_execution_id = NULL")) {
      calls.push({ sql, values });
      txEvents.push("clear-execution-fence");
      return [];
    }
    if (!sql.startsWith("SELECT")) return "fragment";
    calls.push({ sql, values });
    if (options.failAt && sql.startsWith(options.failAt)) throw failure;
    if (sql.startsWith("SELECT privacy_epoch")) return options.missingWorkspace ? [] : [{ privacy_epoch: options.epoch ?? 2 }];
    if (sql.startsWith("SELECT j.*,t.attempt_id") || sql.startsWith("SELECT j.user_turn_id,t.attempt_id") || sql.startsWith("SELECT t.attempt_id,t.context_anchor")) {
      const execValue = options.execution === undefined ? execution : options.execution;
      const status = txNumber >= 2 && options.phase2Status ? options.phase2Status : (options.status ?? "running");
      const anchor = options.anchorAttempt || options.anchorSourceId
        ? { ...(options.anchorAttempt ? { attemptId: options.anchorAttempt } : {}), ...(options.anchorSourceId ? { sourceId: options.anchorSourceId } : {}) }
        : null;
      return options.missingJob ? [] : [{ ...job, status, claim_token: options.token ?? token, timing_execution_id: execValue,
        attempt_id: options.boundAttempt ?? null, context_anchor: anchor,
        source_ids: options.sourceIds ?? [], source_versions: options.sourceVersions ?? null, course_id: options.courseId ?? null }];
    }
    if (sql.startsWith("SELECT id FROM workspaces")) return options.missingWorkspace ? [] : [{ id: workspace }];
    if (sql.startsWith("SELECT id FROM courses")) return options.archivedCourse ? [] : [{ id: options.courseId ?? courseId }];
    if (sql.startsWith("SELECT s.id,s.version FROM opening_sources")) {
      if (options.unavailableSource) return [];
      const requested = Array.isArray(values[1]) ? values[1] as string[] : [sourceId];
      return requested.map(id => ({ id, version: 0 }));
    }
    if (sql.startsWith("SELECT id FROM opening_memories")) {
      return (options.activeGlobalMemoryIds ?? []).map(id => ({ id }));
    }
    if (sql.startsWith("SELECT DISTINCT lower(sid.id::text) AS source_id")) {
      return (options.backedMemorySourceIds ?? []).map(id => ({ source_id: id }));
    }
    if (sql.startsWith("SELECT id FROM course_asset_memberships")) {
      if (sql.includes("purpose='mock_exam'")) {
        return (options.mockExamSourceIds ?? []).length ? [{ id: membershipId }] : [];
      }
      return options.classifiedStandalone ? [{ id: membershipId }] : [];
    }
    if (sql.startsWith("SELECT asset_id,purpose FROM course_asset_memberships")) {
      return options.membershipRemoved ? [] : [{ asset_id: sourceId, purpose: options.derivedMembershipPurpose ?? "teaching" }];
    }
    if (sql.startsWith("SELECT id,asset_id,purpose")) {
      return options.membershipRemoved ? [] : [{ id: membershipId, asset_id: sourceId, purpose: "teaching", purpose_revision: purposeRevision }];
    }
    if (sql.startsWith("SELECT source_id FROM opening_privacy_exclusions")) return [];
    if (sql.startsWith("SELECT 1 WHERE")) return options.unavailableSource ? [] : [{ "?column?": 1 }];
    if (sql.startsWith("SELECT id FROM opening_help_exposures")) return options.missingExposure ? [] : [{ id: receipt }];
    if (sql.startsWith("UPDATE opening_tutor_jobs SET status = 'succeeded'")) return [{ id: jobId }];
    if (sql.startsWith("UPDATE opening_turns SET text =")) return [{ id: assistant }];
    throw new Error(`Unsupported fixture query: ${sql}`);
  }), { json: (value: unknown) => value, unsafe: (value: string) => value });
  const outerCalls: string[] = [];
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    outerCalls.push(query);
    if (query.startsWith("UPDATE opening_tutor_jobs SET timing_execution_id = NULL")) {
      txEvents.push("outer-clear-execution-fence");
      return [];
    }
    if (query.startsWith("SELECT m.id FROM opening_memories m")) {
      return (options.activeGlobalMemoryIds ?? []).map(id => ({ id }));
    }
    return [];
  }), {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      txNumber += 1;
      const currentTx = txNumber;
      txEvents.push(`begin:${currentTx}`);
      try {
        const result = await fn(tx);
        if (options.failCommitAtTx === currentTx) throw failure;
        txEvents.push(`commit:${currentTx}`);
        return result;
      } catch (error) {
        txEvents.push(`rollback:${currentTx}`);
        throw error;
      }
    },
  });
  return {
    repo: createOpeningTutorJobsRepository(sql as unknown as Sql,
      options.tutorStreamRedisUrl ? { tutorStreamRedisUrl: options.tutorStreamRedisUrl } : {}),
    tx, sql, calls, outerCalls, txEvents, failure,
  };
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
    expect(f.calls.map(c => c.sql.split(" ").slice(0, 2).join(" "))).toEqual(["SELECT privacy_epoch", "SELECT j.*,t.attempt_id,t.context_anchor,t.source_ids,t.source_versions,c.course_id", "SELECT 1", "SELECT id"]);
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
  it("commits Phase 1 exposure durably before Phase 2 pure FOR SHARE commitAuthorized and skips on terminal, rollback, or closed stream", async () => {
    const f = fixture();
    const commitAuthorized = vi.fn(() => { f.txEvents.push("commit-authorized"); });
    const out = await f.repo.readStream(scope, jobId, context, commitAuthorized, () => true);
    expect(out).toMatchObject({ id: jobId, status: "running" });
    expect(commitAuthorized).toHaveBeenCalledExactlyOnceWith(out);
    // Phase 1 commits durable exposure release; Phase 2 runs pure read-only FOR SHARE across commitAuthorized.
    expect(f.txEvents).toEqual(["begin:1", "commit:1", "begin:2", "commit-authorized", "commit:2"]);
    expect(hooks.lock).toHaveBeenCalledOnce();
    expect(hooks.release).toHaveBeenCalledOnce();
    const shareSelects = f.calls.filter(c => c.sql.includes("FOR SHARE"));
    expect(shareSelects.some(c => c.sql.startsWith("SELECT privacy_epoch"))).toBe(true);
    expect(shareSelects.some(c => c.sql.startsWith("SELECT j.*,t.attempt_id"))).toBe(true);

    // If Phase 1 COMMIT aborts, Phase 2 never runs and zero bytes are enqueued.
    hooks.release.mockClear();
    const commitFail = fixture({ failCommitAtTx: 1 });
    const commitFailSpy = vi.fn();
    await expect(commitFail.repo.readStream(scope, jobId, context, commitFailSpy, () => true)).rejects.toBe(commitFail.failure);
    expect(commitFailSpy).not.toHaveBeenCalled();
    expect(commitFail.txEvents).toEqual(["begin:1", "rollback:1"]);

    // If client already closed before Phase 1 release, exposure release never runs.
    hooks.release.mockClear();
    const closedStream = fixture();
    const closedSpy = vi.fn();
    await expect(closedStream.repo.readStream(scope, jobId, context, closedSpy, () => false)).rejects.toThrow("stream closed before delivery");
    expect(hooks.release).not.toHaveBeenCalled();
    expect(closedSpy).not.toHaveBeenCalled();

    // If job becomes cancelled between Phase 1 commit and Phase 2 begin, Phase 2 skips commitAuthorized.
    hooks.release.mockClear();
    const cancelledBetween = fixture({ phase2Status: "cancelled" });
    const cancelledSpy = vi.fn();
    expect(await cancelledBetween.repo.readStream(scope, jobId, context, cancelledSpy, () => true))
      .toMatchObject({ status: "cancelled" });
    expect(cancelledSpy).not.toHaveBeenCalled();
    expect(cancelledBetween.txEvents).toEqual(["begin:1", "commit:1", "begin:2", "commit:2"]);

    // Non-receipt streams use a single pure read-only FOR SHARE transaction without history lock or exposure write.
    hooks.lock.mockClear();
    hooks.release.mockClear();
    const noReceipt = fixture();
    const noReceiptSpy = vi.fn(() => { noReceipt.txEvents.push("commit-authorized"); });
    expect(await noReceipt.repo.readStream(scope, jobId, { ...context, exposureReceiptId: null }, noReceiptSpy))
      .toMatchObject({ id: jobId, status: "running" });
    expect(hooks.lock).not.toHaveBeenCalled();
    expect(hooks.release).not.toHaveBeenCalled();
    expect(noReceipt.txEvents).toEqual(["begin:1", "commit-authorized", "commit:1"]);

    const terminal = fixture({ status: "cancelled" });
    const terminalCommit = vi.fn();
    expect(await terminal.repo.readStream(scope, jobId, context, terminalCommit)).toMatchObject({ status: "cancelled" });
    expect(terminalCommit).not.toHaveBeenCalled();

    const rejected = fixture({ courseId, sourceIds: [sourceId], membershipRemoved: true });
    const rejectedCommit = vi.fn();
    await expect(rejected.repo.readStream(scope, jobId, { ...context, materialPurposePin: pin }, rejectedCommit))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(rejectedCommit).not.toHaveBeenCalled();
    expect(rejected.txEvents).toEqual(["begin:1", "rollback:1"]);
  });
  it("fences timing_execution_id in PostgreSQL before releasing locks on UnconfirmedStreamSealError and when sql.begin drops during publish", async () => {
    const f = fixture();
    const sealError = new UnconfirmedStreamSealError(new Error("append timed out"), new Error("redis down"));
    await expect(f.repo.withStreamPublication(scope, jobId, context, async () => { throw sealError; }))
      .rejects.toBe(sealError);
    expect(f.txEvents).toEqual(["begin:1", "clear-execution-fence", "commit:1"]);
    expect(f.calls.some(c => c.sql.startsWith("UPDATE opening_tutor_jobs SET timing_execution_id = NULL"))).toBe(true);

    // If sql.begin drops while publish() is still pending, wait bounded and still clear timing_execution_id on outer sql.
    vi.useFakeTimers();
    try {
      const dropped = fixture();
      const pgDrop = Object.assign(new Error("connection dropped"), { code: "CONNECTION_CLOSED" });
      dropped.sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
        const running = fn(dropped.tx);
        void running.catch(() => undefined);
        // Yield until publish() starts, then fail begin() while publish is still pending.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        throw pgDrop;
      };
      const pending = dropped.repo.withStreamPublication(scope, jobId, context, () => new Promise<void>(() => undefined))
        .then(() => undefined, error => error);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toBe(pgDrop);
      expect(dropped.txEvents).toContain("outer-clear-execution-fence");
    } finally {
      vi.useRealTimers();
    }

    // Even if publish() succeeded cleanly before sql.begin COMMIT failed, still clear timing_execution_id on outer sql.
    const commitFailAfterPublish = fixture({ failCommitAtTx: 1 });
    await expect(commitFailAfterPublish.repo.withStreamPublication(scope, jobId, context, async () => {}))
      .rejects.toBe(commitFailAfterPublish.failure);
    expect(commitFailAfterPublish.txEvents).toContain("outer-clear-execution-fence");

    const fenced = fixture({ execution: null });
    await expect(fenced.repo.readStream(scope, jobId, context)).rejects.toThrow("stream execution changed");
    await expect(fenced.repo.readStream(scope, jobId, { ...context, executionId: undefined })).rejects.toThrow("stream execution changed");
    expect(hooks.release).not.toHaveBeenCalled();
  });
  it("enforces course membership and purpose on derived contextSourceRefs and context_anchor.sourceId in stream and completeTurn", async () => {
    const derivedRefs = [{ sourceId, sourceVersion: 0 }];
    const detached = fixture({ courseId, sourceIds: [], membershipRemoved: true });
    await expect(detached.repo.readStream(scope, jobId, { ...context, contextSourceRefs: derivedRefs }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(detached.repo.completeTurn({
      scope, jobId, assistantTurnId: assistant, text: "derived answer", citations: [], candidates: [],
      contextSourceRefs: derivedRefs, expectedPrivacyEpoch: 2, claimToken: token,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const detachedAnchor = fixture({ courseId, sourceIds: [], anchorSourceId: sourceId, membershipRemoved: true });
    await expect(detachedAnchor.repo.completeTurn({
      scope, jobId, assistantTurnId: assistant, text: "anchored answer", citations: [], candidates: [],
      contextSourceRefs: [], expectedPrivacyEpoch: 2, claimToken: token,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const mockExam = fixture({ courseId, sourceIds: [], derivedMembershipPurpose: "mock_exam" });
    await expect(mockExam.repo.withStreamPublication(scope, jobId, { ...context, contextSourceRefs: derivedRefs }, vi.fn()))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const classifiedStandalone = fixture({ courseId: null, sourceIds: [], classifiedStandalone: true });
    await expect(classifiedStandalone.repo.readStream(scope, jobId, { ...context, contextSourceRefs: derivedRefs }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const sourceLockIndex = classifiedStandalone.calls.findIndex(c => c.sql.startsWith("SELECT s.id,s.version FROM opening_sources") && c.sql.includes("FOR SHARE"));
    const membershipCheckIndex = classifiedStandalone.calls.findIndex(c => c.sql.startsWith("SELECT id FROM course_asset_memberships"));
    expect(sourceLockIndex).toBeGreaterThanOrEqual(0);
    expect(membershipCheckIndex).toBeGreaterThan(sourceLockIndex);
    const allowed = fixture({ courseId, sourceIds: [], derivedMembershipPurpose: "teaching" });
    expect(await allowed.repo.readStream(scope, jobId, { ...context, contextSourceRefs: derivedRefs }))
      .toMatchObject({ status: "running" });
  });

  it("allows active global memory lineage sources on course turns without course membership while blocking superseded, unbound, spoofed, or mock_exam sources", async () => {
    const memorySourceId = "12000000-0000-4000-8000-000000000099";
    const memoryId = "12000000-0000-4000-8000-0000000000aa";
    const memoryRefs = [{ sourceId: memorySourceId, sourceVersion: 0 }];
    // Active global memory backed by an unclassified standalone workspace source succeeds across stream & completeTurn.
    const admitted = fixture({
      courseId, sourceIds: [], membershipRemoved: true,
      activeGlobalMemoryIds: [memoryId], backedMemorySourceIds: [memorySourceId],
    });
    await expect(admitted.repo.withStreamPublication(
      scope, jobId, {
        ...context, contextSourceRefs: memoryRefs,
        memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId],
      }, async () => {},
    )).resolves.toBeUndefined();
    expect(await admitted.repo.readStream(
      scope, jobId, {
        ...context, contextSourceRefs: memoryRefs,
        memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId],
      },
    )).toMatchObject({ status: "running" });
    await expect(admitted.repo.completeTurn({
      scope, jobId, assistantTurnId: assistant, text: "course answer with global memory", citations: [], candidates: [],
      contextSourceRefs: memoryRefs, expectedPrivacyEpoch: 2, claimToken: token,
    }, { memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId] })).resolves.toBeUndefined();
    expect(admitted.calls.some(c => c.sql.startsWith("SELECT id FROM opening_memories") && c.sql.includes("expires_at > clock_timestamp()"))).toBe(true);
    expect(admitted.calls.some(c => c.sql.startsWith("SELECT DISTINCT lower(sid.id::text) AS source_id") && c.sql.includes("m.expires_at > clock_timestamp()"))).toBe(true);
    await expect(admitted.repo.assertGlobalMemoriesCurrent(scope, [memoryId])).resolves.toBeUndefined();
    expect(admitted.outerCalls.some(sql => sql.startsWith("SELECT m.id FROM opening_memories m") && sql.includes("m.expires_at > clock_timestamp()"))).toBe(true);
    await expect(admitted.repo.assertGlobalMemoriesCurrent(scope, ["not-a-uuid"])).rejects.toMatchObject({ code: "CONFLICT" });

    // Missing globalMemoryIds for memoryLineageSourceIds is rejected fail-closed.
    const unbound = fixture({ courseId, sourceIds: [], membershipRemoved: true, backedMemorySourceIds: [memorySourceId] });
    await expect(unbound.repo.readStream(
      scope, jobId, { ...context, contextSourceRefs: memoryRefs, memoryLineageSourceIds: [memorySourceId] },
    )).rejects.toMatchObject({ code: "CONFLICT" });

    // Superseded global memory M1 (no longer active, even if source still has another active memory) is rejected!
    const superseded = fixture({
      courseId, sourceIds: [], membershipRemoved: true,
      activeGlobalMemoryIds: [], backedMemorySourceIds: [memorySourceId],
    });
    await expect(superseded.repo.readStream(
      scope, jobId, {
        ...context, contextSourceRefs: memoryRefs,
        memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId],
      },
    )).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(superseded.repo.completeTurn({
      scope, jobId, assistantTurnId: assistant, text: "superseded memory answer", citations: [], candidates: [],
      contextSourceRefs: memoryRefs, expectedPrivacyEpoch: 2, claimToken: token,
    }, { memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(superseded.repo.assertGlobalMemoriesCurrent(scope, [memoryId])).rejects.toMatchObject({ code: "CONFLICT" });

    // Spoofed memoryLineageSourceIds (not backed by the exact active globalMemoryIds) is rejected fail-closed.
    const spoofed = fixture({
      courseId, sourceIds: [], membershipRemoved: true,
      activeGlobalMemoryIds: [memoryId], backedMemorySourceIds: [],
    });
    await expect(spoofed.repo.readStream(
      scope, jobId, {
        ...context, contextSourceRefs: memoryRefs,
        memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId],
      },
    )).rejects.toMatchObject({ code: "CONFLICT" });

    // A global memory source classified as mock_exam is still rejected.
    const mockExamMemory = fixture({
      courseId, sourceIds: [], membershipRemoved: true,
      activeGlobalMemoryIds: [memoryId], backedMemorySourceIds: [memorySourceId], mockExamSourceIds: [memorySourceId],
    });
    await expect(mockExamMemory.repo.readStream(
      scope, jobId, {
        ...context, contextSourceRefs: memoryRefs,
        memoryLineageSourceIds: [memorySourceId], globalMemoryIds: [memoryId],
      },
    )).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("passes turn source_versions snapshots to assertStreamSources in withStreamPublication and readStream", async () => {
    const f = fixture({ sourceIds: [sourceId], sourceVersions: { [sourceId]: 0 } });
    const snapshotPin = {
      courseId: null, materialUse: "citation" as const,
      sources: [{ sourceId, sourceVersion: 0, membershipId: null, purposeRevision: null, purpose: null }],
    };
    const snapshotContext = {
      ...context, contextSourceRefs: [{ sourceId, sourceVersion: 0 }], materialPurposePin: snapshotPin,
    };
    await expect(f.repo.withStreamPublication(scope, jobId, snapshotContext, async () => {})).resolves.toBeUndefined();
    expect(await f.repo.readStream(scope, jobId, snapshotContext)).toMatchObject({ status: "running" });
    expect(f.calls.some(c => c.sql.includes("t.source_versions"))).toBe(true);
  });

  it("marks fallback stream sealing attempted once when withStreamPublication owns a Redis URL", async () => {
    vi.stubEnv("REDIS_URL", undefined);
    try {
      const noRedis = fixture({ failCommitAtTx: 1 });
      const errNoRedis = await noRedis.repo.withStreamPublication(scope, jobId, context, async () => {})
        .then(() => undefined, error => error);
      expect(errNoRedis).toBe(noRedis.failure);
      expect(hasAttemptedFallbackStreamSeal(errNoRedis)).toBe(false);

      const withRedis = fixture({ failCommitAtTx: 1, tutorStreamRedisUrl: "redis://127.0.0.1:1" });
      const errWithRedis = await withRedis.repo.withStreamPublication(scope, jobId, context, async () => {})
        .then(() => undefined, error => error);
      expect(errWithRedis).toBe(withRedis.failure);
      expect(hasAttemptedFallbackStreamSeal(errWithRedis)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("assertSendAuthorized locks workspaces and opening_tutor_jobs FOR SHARE before checking clock_timestamp() temporary memories, epoch, and execution fence", async () => {
    const memoryId = "12000000-0000-4000-8000-0000000000ab";
    const ok = fixture({ activeGlobalMemoryIds: [memoryId] });
    await expect(ok.repo.assertSendAuthorized(scope, jobId, {
      expectedPrivacyEpoch: 2, claimToken: token, executionId: execution,
      contextSourceRefs: [], globalMemoryIds: [memoryId],
    })).resolves.toBeUndefined();
    const wsIdx = ok.calls.findIndex(c => c.sql.startsWith("SELECT privacy_epoch FROM workspaces") && c.sql.includes("FOR SHARE"));
    const jobIdx = ok.calls.findIndex(c => c.sql.startsWith("SELECT j.user_turn_id,t.attempt_id") && c.sql.includes("timing_execution_id") && c.sql.includes("FOR SHARE OF j"));
    const memIdx = ok.calls.findIndex(c => c.sql.startsWith("SELECT id FROM opening_memories") && c.sql.includes("expires_at > clock_timestamp()"));
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(jobIdx).toBeGreaterThan(wsIdx);
    expect(memIdx).toBeGreaterThan(jobIdx);

    const driftedEpoch = fixture({ epoch: 3, activeGlobalMemoryIds: [memoryId] });
    await expect(driftedEpoch.repo.assertSendAuthorized(scope, jobId, {
      expectedPrivacyEpoch: 2, claimToken: token, executionId: execution,
      contextSourceRefs: [], globalMemoryIds: [memoryId],
    })).rejects.toMatchObject({ code: "PRIVACY_EPOCH_MISMATCH" });

    const missingJob = fixture({ missingJob: true, activeGlobalMemoryIds: [memoryId] });
    await expect(missingJob.repo.assertSendAuthorized(scope, jobId, {
      expectedPrivacyEpoch: 2, claimToken: token, executionId: execution,
      contextSourceRefs: [], globalMemoryIds: [memoryId],
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const expiredMemory = fixture({ activeGlobalMemoryIds: [] });
    await expect(expiredMemory.repo.assertSendAuthorized(scope, jobId, {
      expectedPrivacyEpoch: 2, claimToken: token, executionId: execution,
      contextSourceRefs: [], globalMemoryIds: [memoryId],
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("authorizeSend starts provider synchronously inside FOR SHARE transaction without holding DB across network wait, and rechecks clock_timestamp() after all blocking queries", async () => {
    const memoryId = "12000000-0000-4000-8000-0000000000ac";
    const f = fixture({ courseId, sourceIds: [], derivedMembershipPurpose: "teaching", activeGlobalMemoryIds: [memoryId] });
    let resolveNetwork!: (value: string) => void;
    const network = new Promise<string>(resolve => { resolveNetwork = resolve; });
    const started = f.repo.authorizeSend(
      scope, jobId,
      {
        expectedPrivacyEpoch: 2, claimToken: token, executionId: execution,
        contextSourceRefs: [{ sourceId, sourceVersion: 0 }], globalMemoryIds: [memoryId],
      },
      () => {
        f.txEvents.push("start-send-sync");
        return network;
      },
      () => { f.txEvents.push("before-start-sync"); },
    );
    // DB transaction commits immediately after synchronous startSend(), while network promise is still pending!
    await vi.waitFor(() => expect(f.txEvents).toEqual(["begin:1", "before-start-sync", "start-send-sync", "commit:1"]));
    // Final SQL query before startSend() is the non-blocking clock_timestamp() temporary memory check,
    // strictly AFTER course_asset_memberships FOR SHARE and assertStreamSources (SELECT 1 WHERE)!
    const membershipIdx = f.calls.findIndex(c => c.sql.startsWith("SELECT asset_id,purpose FROM course_asset_memberships"));
    const sourcesIdx = f.calls.findIndex(c => c.sql.startsWith("SELECT 1 WHERE"));
    const lastMemIdx = f.calls.findLastIndex(c => c.sql.startsWith("SELECT id FROM opening_memories") && c.sql.includes("expires_at > clock_timestamp()"));
    expect(membershipIdx).toBeGreaterThanOrEqual(0);
    expect(sourcesIdx).toBeGreaterThan(membershipIdx);
    expect(lastMemIdx).toBeGreaterThan(sourcesIdx);
    expect(lastMemIdx).toBe(f.calls.length - 1);
    resolveNetwork("provider-ok");
    expect(await started).toBe("provider-ok");

    // Verify readStream Phase 2 ALSO runs expires_at > clock_timestamp() as the final SQL query before commitAuthorized.
    const sse = fixture({ courseId, sourceIds: [], derivedMembershipPurpose: "teaching", activeGlobalMemoryIds: [memoryId] });
    const commitAuthorized = vi.fn();
    await sse.repo.readStream(scope, jobId, {
      ...context, exposureReceiptId: null, contextSourceRefs: [{ sourceId, sourceVersion: 0 }], globalMemoryIds: [memoryId],
    }, commitAuthorized);
    expect(commitAuthorized).toHaveBeenCalledOnce();
    const sseSourcesIdx = sse.calls.findLastIndex(c => c.sql.startsWith("SELECT 1 WHERE"));
    const sseLastMemIdx = sse.calls.findLastIndex(c => c.sql.startsWith("SELECT id FROM opening_memories") && c.sql.includes("expires_at > clock_timestamp()"));
    expect(sseLastMemIdx).toBeGreaterThan(sseSourcesIdx);
    expect(sseLastMemIdx).toBe(sse.calls.length - 1);
    expect(f.calls[lastMemIdx]?.sql).toContain("WITH RECURSIVE mem_deps(dep_id)");
    expect(sse.calls[sseLastMemIdx]?.sql).toContain("WITH RECURSIVE mem_deps(dep_id)");
  });
});
