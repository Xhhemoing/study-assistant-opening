import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedOpeningSystemQueryReader, createOpeningEphemeralProvenanceRepository, createOpeningPrivacyRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import type { EphemeralTurnInput } from "@aistudy/contracts";
import { getEphemeralTutorService, getTutorService } from "../../apps/web/src/features/opening/runtime";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { replyEphemeralSystemQuery } from "../../apps/web/src/features/opening/tutor/ephemeral-system-query";
import { backupRows } from "./opening-backup-records-fixture";
import { localDateKeyInZone } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
const forbidden = vi.fn(async (): Promise<never> => { throw new Error("forbidden real model/RAG/mutation path"); });
const unavailableModel = vi.fn(async (): Promise<never> => { throw new Error("SIMULATED unavailable planner"); });
const ephemeral = (text: string, extra: Partial<EphemeralTurnInput> = {}): EphemeralTurnInput => ({ text, sourceIds: [], sourceSelection: "none", mode: "listen", purpose: "answer", history: [], ...extra });
const queryService = () => createDbSystemQueryService(f.sql, "worker", { callModel: unavailableModel });
function processTurn() {
  return createTutorTurnHandler({ systemQuery: queryService(), tutorJobs: createOpeningTutorJobsRepository(f.sql),
    chunks: { listForSources: forbidden, listChunksAtVersion: forbidden }, provider: { complete: forbidden }, resolveModel: forbidden,
    budget: { reserve: forbidden, release: forbidden, claimExecution: forbidden, settle: forbidden, markUnknown: forbidden },
    privacy: createOpeningPrivacyRepository(f.sql),
    config: { maxContextCharacters: 12000, reservedCents: 1, maxOutputTokens: 100, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
}
async function course(title: string, other = false) {
  const id = randomUUID(); await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${id},${other ? f.otherScope.workspaceId : f.scope.workspaceId},${title},${id})`; return id;
}
async function plan(date: string, courseId: string, title: string) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,course_id) VALUES (${id},${f.scope.workspaceId},${f.scope.ownerUserId},${title},30,${courseId})`;
  const blocks = [{ taskId: id, start: `${date}T09:00:00Z`, end: `${date}T09:30:00Z`, reason: "test confirmed plan" }];
  await f.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks) VALUES (${f.scope.workspaceId},${date},1,${JSON.stringify(blocks)}::text::jsonb)
    ON CONFLICT(workspace_id,day) DO UPDATE SET accepted_version=opening_plan_state.accepted_version+1,accepted_blocks=opening_plan_state.accepted_blocks||excluded.accepted_blocks`;
  return id;
}
async function reply(text: string, extra: Partial<EphemeralTurnInput> = {}) {
  return replyEphemeralSystemQuery({ systemQuery: queryService(), provenance: createOpeningEphemeralProvenanceRepository(f.sql) }, f.scope, ephemeral(text, extra));
}
beforeEach(async () => {
  f = await createOpeningFixture(); forbidden.mockClear(); unavailableModel.mockClear();
  vi.stubEnv("OPENING_SYSTEM_QUERY", "1"); vi.stubEnv("OPENING_MODEL_CATALOG", "invalid catalog prevents all real calls"); vi.stubGlobal("fetch", forbidden);
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (!f) return;
  try {
    const workspaces = [f.scope.workspaceId, f.otherScope.workspaceId];
    await f.sql`DELETE FROM opening_tasks WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await f.sql`DELETE FROM opening_sources WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await f.sql`DELETE FROM courses WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await f.sql`DELETE FROM workspaces WHERE id=ANY(${workspaces}::uuid[])`;
    await f.sql`DELETE FROM sessions WHERE user_id=ANY(${[f.scope.ownerUserId, f.otherScope.ownerUserId]}::uuid[])`;
    await f.sql`DELETE FROM users WHERE id=ANY(${[f.scope.ownerUserId, f.otherScope.ownerUserId]}::uuid[])`;
  } finally { await f.close(); }
});

describe("automatic scoped reads, real PostgreSQL and simulated unavailable planner", () => {
  it("routes a saved default-answer turn without PDF and persists fresh follow-up receipts", async () => {
    const id = await course("高等数学");
    const tutor = getTutorService(f.sql), conversation = await tutor.createConversation(f.scope, { title: "Automatic", courseId: id });
    const ask = async (text: string) => {
      const queued = await tutor.submitTurn(f.scope, { conversationId: conversation.id, text, purpose: "answer", sourceIds: [], privacy: "saved", mode: "listen", clientKey: randomUUID() });
      expect(queued.learningSessionId).toBeNull(); await processTurn()(queued.jobId);

    };
    await ask("高数进度怎么样"); await ask("那练习情况呢");
    const turns = await tutor.listTurns(f.scope, conversation.id), assistants = turns.filter(row => row.role === "assistant");
    expect(assistants).toHaveLength(2); expect(assistants.every(row => row.status === "complete")).toBe(true);
    expect(assistants[0]?.systemQuery?.results.map(row => row.name)).toEqual(["courses", "learner_state"]);
    expect(assistants[1]?.systemQuery?.results.map(row => row.name)).toEqual(["courses", "learning"]);
    expect(assistants[1]?.systemQuery?.results.at(-1)).toMatchObject({ status: "unknown", reason: "no_data" });
    expect(forbidden).not.toHaveBeenCalled();
    const taskId = await plan("2026-10-20", id, "Saved fresh task");
    await ask("高数明天计划是什么");
    await f.sql`UPDATE opening_tasks SET status='done',version=version+1 WHERE id=${taskId}`;
    await ask("刷新");
    const refreshed = (await tutor.listTurns(f.scope, conversation.id)).filter(row => row.role === "assistant").at(-1)!;
    expect(refreshed.systemQuery?.results.at(-1)?.data[0]).toMatchObject({ taskId, taskStatus: "done" });
    const [counts] = await f.sql`SELECT (SELECT count(*)::int FROM opening_learning_sessions WHERE workspace_id=${f.scope.workspaceId}) AS sessions,
      (SELECT count(*)::int FROM opening_help_exposures WHERE workspace_id=${f.scope.workspaceId}) AS help`;
    expect(counts).toMatchObject({ sessions: 0, help: 0 });
  });
  it("routes the ephemeral runtime default answer and never calls a real provider", async () => {
    await course("高等数学");
    const result = await getEphemeralTutorService(f.sql).replyEphemeral(f.scope, ephemeral("高数进度怎么样"));
    expect(result.systemQuery?.results.map(row => row.name)).toEqual(["courses", "learner_state"]);
    expect(result.provenanceId).toBeTruthy(); expect(forbidden).not.toHaveBeenCalled();
  });
  it("refreshes changed task evidence and does not reuse the old text as facts", async () => {
    const id = await course("高等数学"), taskId = await plan("2026-10-20", id, "Fresh task");
    const first = await reply("高数明天计划是什么");
    expect(first.systemQuery?.results.at(-1)?.data[0]).toMatchObject({ taskId, taskStatus: "pending" });
    await f.sql`UPDATE opening_tasks SET status='done',version=version+1 WHERE id=${taskId}`;
    const history = [{ role: "user" as const, text: "高数明天计划是什么", provenanceId: first.provenanceId! }, { role: "assistant" as const, text: first.text, provenanceId: first.provenanceId! }];
    const second = await reply("刷新", { history, historyPrivacyEpoch: first.privacyEpoch });
    expect(second.systemQuery?.results.at(-1)?.data[0]).toMatchObject({ taskId, taskStatus: "done", date: "2026-10-20" });
    expect(second.historyDiscarded).toBe(false);
    expect(second.systemQuery?.results.at(-1)?.evidence[0]?.revision).toBe("2");
  });
  it("switches A focus to B explicitly and isolates courses within a workspace", async () => {
    const a = await course("高等数学"), b = await course("大学物理");
    await plan("2026-10-20", a, "A only"); const taskId = await plan("2026-10-20", b, "B only");
    const direct = await createScopedOpeningSystemQueryReader(f.sql, f.scope)({ name: "planning", arguments: { date: "2026-10-20", courseId: b, limit: 5, offset: 0 } }, new AbortController().signal);
    expect(direct.reason).toBe("read");
    const result = await reply("《大学物理》明天计划是什么", { courseId: a });
    expect(result.systemQuery?.results.at(-1)?.reason).toBe("read");
    expect(result.systemQuery?.results.at(-1)?.data).toEqual([expect.objectContaining({ taskId, title: "B only" })]);
    expect(result.text).not.toContain("A only");
  });
  it("does not use another workspace's or unrelated unique course", async () => {
    await course("大学英语"); await course("高等数学", true);
    const result = await reply("高数进度怎么样");
    expect(result.systemQuery?.reason).toBe("course_not_found"); expect(result.systemQuery?.results).toHaveLength(1);
  });
  it("clarifies duplicate courses and reports no courses separately", async () => {
    expect((await reply("高数进度怎么样")).systemQuery?.reason).toBe("course_not_found");
    await course("高等数学"); await course("高等数学");
    expect((await reply("高数进度怎么样")).systemQuery?.reason).toBe("clarify_course");
  });
  it("discards old epoch and expired ephemeral history while still reading current records", async () => {
    await course("高等数学"); const first = await reply("高数进度怎么样");
    const history = [{ role: "user" as const, text: "高数进度怎么样", provenanceId: first.provenanceId! }];
    await f.sql`UPDATE opening_query_ephemeral_provenance SET expires_at=now()-interval '1 second' WHERE id=${first.provenanceId!}`;
    const expired = await reply("那练习情况呢", { history, historyPrivacyEpoch: first.privacyEpoch });
    expect(expired.historyDiscarded).toBe(true);
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    const changed = await reply("高数练习情况", { history, historyPrivacyEpoch: first.privacyEpoch });
    expect(changed.historyDiscarded).toBe(true); expect(changed.privacyEpoch).toBe(1);
  });
  it("returns forbidden after ownership permission changes, without releasing an old receipt", async () => {
    await course("高等数学"); const first = await reply("高数进度怎么样");
    await f.sql`DELETE FROM courses WHERE workspace_id=${f.otherScope.workspaceId}`;
    await f.sql`DELETE FROM workspaces WHERE id=${f.otherScope.workspaceId}`;
    await f.sql`UPDATE workspaces SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
    await expect(reply("高数进度怎么样", { history: [{ role: "assistant", text: first.text, provenanceId: first.provenanceId! }], historyPrivacyEpoch: first.privacyEpoch })).rejects.toMatchObject({ code: "SYSTEM_QUERY_FORBIDDEN", status: 403 });
  });
});

it("keeps materials inside B after switching away from A's source focus", async () => {
  const a = await course("高等数学"), b = await course("大学物理"), rows = backupRows(f.sql, f.scope);
  const sourceA = await rows.source(), sourceB = await rows.source(); await rows.chunk(sourceA); await rows.chunk(sourceB);
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES
    (${f.scope.workspaceId},${a},'source',${sourceA},'core','course'),(${f.scope.workspaceId},${b},'source',${sourceB},'core','course')`;
  const result = await reply("《大学物理》的学习进度和材料记录有哪些", { courseId: a, sourceIds: [sourceA], sourceSelection: "selected", currentPage: 1 });
  const material = result.systemQuery?.results.find(row => row.name === "materials");
  expect(material?.sourceRefs).toEqual([{ sourceId: sourceB, sourceVersion: 1 }]);
  expect(material?.data).toEqual([expect.objectContaining({ sourceId: sourceB, exposure: "content_withheld" })]);
  expect(JSON.stringify(result.systemQuery)).not.toContain(sourceA);
});
it("resolves tomorrow in the workspace timezone rather than the UTC calendar day", async () => {
  const id = await course("高等数学"), zone = "Pacific/Kiritimati";
  const today = localDateKeyInZone(new Date(), zone), tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  await f.sql`INSERT INTO workspace_preferences(workspace_id,planning_settings) VALUES (${f.scope.workspaceId},${JSON.stringify({ timeZone: zone })}::text::jsonb)
    ON CONFLICT(workspace_id) DO UPDATE SET planning_settings=excluded.planning_settings`;
  await plan(tomorrow, id, "Local tomorrow");
  const result = await reply("明天计划是什么");
  expect(result.systemQuery?.results.at(-1)?.data[0]).toMatchObject({ date: tomorrow, timeZone: zone });
});
it("uses the current course anchor consistently in saved and ephemeral reads", async () => {
  await course("高等数学"); const id = await course("大学物理");
  const contextAnchor = { purpose: "learning_help" as const, courseId: id };
  const ephemeralReply = await reply("我的练习情况", { contextAnchor });
  expect(ephemeralReply.systemQuery?.results[0]?.data[0]).toMatchObject({ id, title: "大学物理" });
  expect(ephemeralReply.systemQuery?.results.at(-1)?.name).toBe("learning");
  const tutor = getTutorService(f.sql), conversation = await tutor.createConversation(f.scope, { title: "Anchor", courseId: null });
  const queued = await tutor.submitTurn(f.scope, { conversationId: conversation.id, text: "我的练习情况", purpose: "answer", contextAnchor, sourceIds: [], privacy: "saved", mode: "listen", clientKey: randomUUID() });
  await processTurn()(queued.jobId);
  const saved = (await tutor.listTurns(f.scope, conversation.id)).find(row => row.role === "assistant")!;
  expect(saved.status).toBe("complete");
  expect(saved.systemQuery?.results[0]?.data[0]).toMatchObject({ id, title: "大学物理" });
  expect(saved.systemQuery?.results.at(-1)?.name).toBe("learning");
});
