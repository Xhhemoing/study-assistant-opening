import { randomUUID } from "node:crypto";
import type { MaterialRetriever } from "@aistudy/ai";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import {
  createCourseMembershipRepository, createOpeningBudgetRepository,
  createOpeningConversationRepository, createOpeningEphemeralProvenanceRepository,
  createOpeningSourceChunksRepository, createOpeningSourceRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningPrivacyRepository } from "../../packages/database/src/repositories/opening-privacy";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const config = { maxContextCharacters: 5000, maxOutputTokens: 256, reservedCents: 10,
  inputCentsPerMillion: 1, outputCentsPerMillion: 1 };
const output: ProviderOutput = { requestId: "producer-compatibility-provider", text: "Synthetic material answer",
  citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1 };

type Caller = "saved" | "ephemeral";
async function callerFixture(kind: Caller, courseOwned: boolean, selected: boolean) {
  const sources = createOpeningSourceRepository(f.sql);
  const source = await sources.create(f.scope, { name: "compatibility.txt", mime: "text/plain", bytes: 12, sha256: "c".repeat(64) });
  await f.sql`UPDATE opening_sources SET upload_state='uploaded',parse_state='ready' WHERE id=${source.id}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${source.id}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${source.id},0,1,'Synthetic compatibility material')`;
  const courses = createCourseMembershipRepository(f.sql);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Caller compatibility", slug: randomUUID() });
  // An unclassified membership also supports the existing standalone path.
  const membershipInput = { workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: source.id };
  const membership = await courses.addAssetMembership({ ...membershipInput, role: "core", visibility: "course",
    purpose: courseOwned ? "reference" : null });
  const courseId = courseOwned ? course.id : null;
  const sourceIds = selected ? [source.id] : [];
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100000 });
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const privacy = createOpeningPrivacyRepository(f.sql);
  const realRetrieve = createOpeningMaterialRetriever(f.sql, budget, null);
  // Observe the actual caller-owned course/use and real PG pin, forwarding all
  // admission and assertCurrent behavior unchanged (never an admission mock).
  const retrieveContext = vi.fn(async (scope: Parameters<MaterialRetriever>[0], input: Parameters<MaterialRetriever>[1]) =>
    realRetrieve(scope, input));
  const provider = { complete: vi.fn(async (_input: ProviderInput): Promise<ProviderOutput> => output) };
  const text = "Explain this selected passage";
  let assistantTurnId: string | undefined;
  let jobId: string | undefined;
  let run: () => Promise<unknown>;
  if (kind === "saved") {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "Compatibility", courseId });
    const saved = await conversations.appendSavedTurn({ scope: f.scope, conversationId: conversation.id, text,
      mode: "explain", clientKey: randomUUID(), sourceIds, learningSessionId: null, currentPage: null, chunkId: null });
    assistantTurnId = saved.assistantTurnId;
    jobId = saved.jobId;
    const handler = createTutorTurnHandler({ tutorJobs: createOpeningTutorJobsRepository(f.sql), chunks, budget,
      provider, retrieveContext, privacy, config });
    run = () => handler(saved.jobId);
  } else {
    const service = createEphemeralTutorService({ chunks, provider, retrieveContext, config,
      sources: { listOwnedIds: async (scope, ids) => {
        const owned: string[] = [];
        for (const id of ids) { await sources.get(scope, id); owned.push(id); }
        return owned;
      } },
      privacy: { snapshot: async scope => ({ epoch: await privacy.getWorkspaceEpoch(scope),
        excludedSourceIds: await privacy.listExcludedSourceIds(scope) }), currentEpoch: scope => privacy.getWorkspaceEpoch(scope) },
      provenance: createOpeningEphemeralProvenanceRepository(f.sql),
      budget: { reserve: input => budget.reserve(f.scope, input), release: (id, reason) => budget.release(f.scope, id, reason),
        claimExecution: id => budget.claimExecution(f.scope, id), settle: (...args) => budget.settle(f.scope, ...args),
        markUnknown: id => budget.markUnknown(f.scope, id) },
    });
    run = () => service.replyEphemeral(f.scope, { text, ...(courseId ? { courseId } : {}), sourceIds,
      sourceSelection: selected ? "selected" : "none", history: [], mode: "explain", clientKey: randomUUID() });
  }
  return { source, courseId, sourceIds, provider, retrieveContext, run, assistantTurnId, jobId,
    classify: () => courses.updateAssetMembership({ ...membershipInput, purpose: "reference",
      expectedUpdatedAt: membership.updatedAt.toISOString() }) };
}

describe("producer merge real caller compatibility (PG)", () => {
  it.each((["saved", "ephemeral"] as const).flatMap(kind => [true, false].flatMap(courseOwned =>
    [true, false].map(selected => ({ kind, courseOwned, selected }))))
  )("supports $kind courseOwned=$courseOwned selected=$selected with actual citation admission", async ({ kind, courseOwned, selected }) => {
    const caller = await callerFixture(kind, courseOwned, selected);
    const result = await caller.run();
    expect(caller.retrieveContext).toHaveBeenCalledOnce();
    expect(caller.retrieveContext.mock.calls[0]![1]).toMatchObject({ sourceIds: caller.sourceIds,
      courseContext: { courseId: caller.courseId, materialUse: "citation" } });
    const retrieved = await caller.retrieveContext.mock.results[0]!.value;
    expect(retrieved.purposePin).toMatchObject({ courseId: caller.courseId, materialUse: "citation",
      sources: selected ? [{ sourceId: caller.source.id, purpose: courseOwned ? "reference" : null }] : [] });
    expect(caller.provider.complete).toHaveBeenCalledOnce();
    expect(caller.provider.complete.mock.calls[0]![0].chunks.map(chunk => chunk.sourceId)).toEqual(caller.sourceIds);
    if (kind === "saved") {
      expect((await f.sql`SELECT status,text FROM opening_turns WHERE id=${caller.assistantTurnId!}`)[0])
        .toMatchObject({ status: "complete", text: output.text });
      expect((await createOpeningTutorJobsRepository(f.sql).get(f.scope, caller.jobId!))?.status).toBe("succeeded");
    } else expect(result).toMatchObject({ text: output.text, provenanceId: expect.any(String) });
  });

  it.each(["saved", "ephemeral"] as const)("rejects classified selected material in the real %s null-course path before provider send", async kind => {
    const caller = await callerFixture(kind, false, true);
    await caller.classify();
    await expect(caller.run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.retrieveContext.mock.calls[0]![1].courseContext).toEqual({ courseId: null, materialUse: "citation" });
    expect(caller.provider.complete).not.toHaveBeenCalled();
    if (kind === "saved") {
      expect((await f.sql`SELECT status FROM opening_turns WHERE id=${caller.assistantTurnId!}`)[0]!.status).toBe("failed");
    }
  });
});
