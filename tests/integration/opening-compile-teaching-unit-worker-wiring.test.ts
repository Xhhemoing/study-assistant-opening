/**
 * PR-D: completed-key replay through the REAL worker wiring
 * (createCompileTeachingUnitWorkerDeps, as constructed by apps/worker main):
 * the real loadReplayedResult → teachingActivities.get, real publish, real
 * ledger. Replay never calls the provider and returns the existing result.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository,
} from "@aistudy/database";
import type { OpeningJobRecord } from "@aistudy/database";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
const modelRequests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
const modelServer = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "teaching-wiring-model-response",
    choices: [{ message: { content: JSON.stringify({
      itemTitles: ["秩与零空间"],
      blocks: [
        { type: "text", text: "矩阵的秩与零空间维数之和等于列数。" },
        { type: "prompt", text: "一个 3×5 矩阵的秩为 2，零空间维数是多少？" },
        { type: "answer_key", text: "5 − 2 = 3", hints: {
          direction: "先找矩阵的列数与秩。", concept: "秩与零空间维数之和等于列数。",
          firstStep: "将列数 5 和秩 2 代入 rank(A) + dim N(A) = 5。",
        } },
      ],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  }));
});
beforeAll(async () => {
  f = await createOpeningFixture();
  await new Promise<void>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
});
beforeEach(async () => { await f.reset(); modelRequests.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await f?.close();
  if (modelServer.listening) await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()));
});

async function ledger() {
  const rows = await f.sql`
    SELECT count(*)::int AS rows,
      COALESCE(sum(amount_cents) FILTER (WHERE state='completed'),0)::int AS used,
      COALESCE(sum(amount_cents) FILTER (WHERE state='reserved'),0)::int AS reserved,
      COALESCE(sum(pending_reconcile_cents),0)::int AS pending,
      max(result_ref) AS result_ref
    FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  return rows[0] as unknown as { rows: number; used: number; reserved: number; pending: number; result_ref: string | null };
}

describe("compile-teaching-unit worker wiring: completed replay", () => {
  it("loads the persisted activity via the production loader; provider not called again, no new charge", async () => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
    vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "0");
    vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    vi.stubEnv("OPENING_MODEL_API_KEY", "test-wiring-key");
    vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "100000");
    vi.stubEnv("OPENING_MODEL_DEFAULT_ID", "wiring-model");
    vi.stubEnv("OPENING_MODEL_CATALOG", JSON.stringify([{
      id: "wiring-model", label: "Wiring fixture", providerId: "wiring-provider", providerLabel: "Wiring fixture",
      modelName: "wiring-model", apiKeyEnv: "OPENING_MODEL_API_KEY",
      baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
      inputCentsPerMillion: 10000, outputCentsPerMillion: 10000,
    }]));
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
      budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
      chunks: createOpeningSourceChunksRepository(f.sql),
      privacy: createOpeningPrivacyRepository(f.sql),
    });
    // Keep production routing, provider, ledger and loader; only HTTP replies are fixtures.
    const loaderSpy = vi.spyOn(deps, "loadReplayedResult");
    const publishSpy = vi.spyOn(deps, "publishActivitySpec");
    const run = createCompileTeachingUnitHandler(deps);

    const activities = createOpeningTeachingActivitiesRepository(f.sql);
    const activity = await activities.create(f.scope, {
      clientKey: `wiring-${randomUUID()}`, intentKind: "topic", intentSummary: "wiring replay", createIntent: { t: 1 },
    });
    await activities.setGenerateStatus(f.scope, activity.id, "queued");
    const unit = await createOpeningTeachingContentRepository(f.sql).createUnit(f.scope, { title: "unit", blocks: [{ id: randomUUID(), type: "text", content: { markdown: "seed" } }] });
    const job: OpeningJobRecord = {
      id: randomUUID(), workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId,
      key: "k", kind: "compile-teaching-unit", payload: {}, result: null, state: "running", privacyEpoch: 0,
    };
    const payload = { mode: "generate" as const, activityId: activity.id, teachingUnitId: unit.id, expectedContentVersion: 0, clientKey: "client-key-01", sourceIds: [] };

    await run(job, payload);
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatchObject({ model: "wiring-model" });
    expect(modelRequests[0]!.messages.some(message => message.content.includes("wiring replay"))).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]![1]).toMatchObject({
      revisionNumber: 2, generationConfig: { extras: { contentSource: "model" } },
    });
    const persisted = await activities.get(f.scope, activity.id);
    expect(persisted?.generateStatus).toBe("needs_check");
    const before = await ledger();
    expect(before).toMatchObject({ rows: 1, used: 2, reserved: 0, pending: 0, result_ref: `teaching_activity:${activity.id}` });

    const replay = await run(job, payload);
    expect(replay).toEqual({ replayed: true, activityId: activity.id, generateStatus: "needs_check" });
    expect(loaderSpy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: f.scope.workspaceId }), `teaching_activity:${activity.id}`);
    expect(modelRequests).toHaveLength(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const after = await ledger();
    expect(after).toEqual(before);
    expect((await activities.get(f.scope, activity.id))?.generateStatus).toBe("needs_check");

    if (process.env.BUDGET_MATRIX_OUT) {
      appendFileSync(process.env.BUDGET_MATRIX_OUT, `${JSON.stringify({ case: "compile-teaching-unit replay via worker wiring", logicalOps: 2, providerCalls: modelRequests.length, used: after.used, reserved: after.reserved, pending: after.pending, reconcileEvents: "-", outcome: "production loader returned needs_check; no provider/publish" })}\n`);
    }
  });

  it("production loader is scope-bound and rejects foreign refs", async () => {
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
      budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
      chunks: createOpeningSourceChunksRepository(f.sql),
      privacy: createOpeningPrivacyRepository(f.sql),
    });
    const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
      clientKey: `wiring-${randomUUID()}`, intentKind: "topic", intentSummary: "scope", createIntent: { t: 2 },
    });
    expect(await deps.loadReplayedResult(f.scope, `teaching_activity:${activity.id}`)).toMatchObject({ activityId: activity.id });
    expect(await deps.loadReplayedResult(f.otherScope, `teaching_activity:${activity.id}`)).toBeNull();
    expect(await deps.loadReplayedResult(f.scope, `opening_turn:${activity.id}`)).toBeNull();
  });
});
