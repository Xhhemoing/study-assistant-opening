import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ephemeralTurnResponseSchema } from "@aistudy/contracts";
import { POST as ephemeralPost } from "../../../apps/web/src/app/api/opening/ephemeral/route";
import { POST as savedPost } from "../../../apps/web/src/app/api/opening/turns/route";
import { complete, ephemeralCounts, postEphemeral, resetEphemeralRows, sql, startEphemeralHandler, stopEphemeralHandler, tablesContainingEphemeralMarker, workspaceForCookie } from "./opening-ephemeral-harness";

beforeAll(startEphemeralHandler);
beforeEach(async () => { await resetEphemeralRows(); vi.stubEnv("OPENING_SYSTEM_QUERY", "1"); vi.stubEnv("OPENING_MODEL_CATALOG", "invalid catalog"); vi.stubEnv("OPENING_MODEL_API_KEY", ""); });
afterEach(() => vi.unstubAllEnvs());
afterAll(stopEphemeralHandler);

it.each(["0", "1"])("HTTP ephemeral query uses current records and stores no body (adaptive=%s)", async adaptive => {
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", adaptive);
  const marker = `HTTP_PRIVATE_${randomUUID()}`, before = await ephemeralCounts();
  const response = await ephemeralPost(postEphemeral({ querySystem: true, text: `模型设置 ${marker}`, sourceIds: [], mode: "listen", history: [] }));
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = ephemeralTurnResponseSchema.parse(await response.json());
  expect(body.systemQuery!.results[0].data[0]).toMatchObject({ process: "web", adaptivePlanning: adaptive === "1" });
  expect(await ephemeralCounts()).toEqual(before); expect(complete).not.toHaveBeenCalled();
  expect(await tablesContainingEphemeralMarker(marker)).toEqual([]);
  const [row] = await sql`SELECT context_source_refs FROM opening_query_ephemeral_provenance WHERE id=${body.provenanceId!}`;
  expect(row!.context_source_refs).toEqual([]);
});

it("HTTP saved query binds persisted intent and a new intent cannot reuse its client key", async () => {
  const workspaceId = await workspaceForCookie(), conversationId = randomUUID();
  await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
    SELECT ${conversationId},id,owner_user_id,'HTTP query' FROM workspaces WHERE id=${workspaceId}`;
  const input = { conversationId, querySystem: true, text: "模型设置", sourceIds: [], mode: "explain", privacy: "saved", clientKey: randomUUID() };
  const response = await savedPost(postEphemeral(input)); expect(response.status).toBe(201);
  const created = await response.json();
  const replay = await savedPost(postEphemeral(input)); expect(await replay.json()).toEqual(created);
  const conflict = await savedPost(postEphemeral({ ...input, querySystem: false })); expect(conflict.status).toBe(409);
  const turns = await sql`SELECT query_system,learning_session_id,attempt_id FROM opening_turns WHERE conversation_id=${conversationId}`;
  expect(turns).toHaveLength(2); expect(turns.every(turn => turn.query_system && turn.learning_session_id === null && turn.attempt_id === null)).toBe(true);
  expect(complete).not.toHaveBeenCalled();
});

it("HTTP rejects forged scope, invalid types and disabled query intent", async () => {
  const input = { querySystem: true, text: "模型设置", sourceIds: [], mode: "listen", history: [] };
  for (const body of [{ ...input, workspaceId: randomUUID() }, { ...input, querySystem: "true" }, { ...input, history: null }]) {
    expect((await ephemeralPost(postEphemeral(body))).status).toBe(400);
  }
  vi.stubEnv("OPENING_SYSTEM_QUERY", "0");
  expect((await ephemeralPost(postEphemeral(input))).status).toBe(409);
  expect(complete).not.toHaveBeenCalled();
  const [count] = await sql`SELECT count(*)::int AS n FROM opening_query_ephemeral_provenance`;
  expect(count!.n).toBe(0);
});

it("HTTP routes default-answer state questions in both modes without manual query selection", async () => {
  const response = await ephemeralPost(postEphemeral({ text: "今天计划是什么", purpose: "answer", sourceIds: [], mode: "listen", history: [] }));
  expect(response.status).toBe(200);
  const body = ephemeralTurnResponseSchema.parse(await response.json());
  expect(body.systemQuery?.results[0]).toMatchObject({ name: "planning", reason: "no_data" });
  const workspaceId = await workspaceForCookie(), conversationId = randomUUID();
  await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
    SELECT ${conversationId},id,owner_user_id,'HTTP automatic' FROM workspaces WHERE id=${workspaceId}`;
  const queued = await savedPost(postEphemeral({ conversationId, text: "当前任务", purpose: "answer", sourceIds: [], mode: "listen", privacy: "saved", clientKey: randomUUID() }));
  expect(queued.status).toBe(201);
  const [turn] = await sql`SELECT query_system,composer_purpose FROM opening_turns WHERE conversation_id=${conversationId} AND role='user'`;
  expect(turn).toMatchObject({ query_system: true, composer_purpose: "query" });
  expect(complete).not.toHaveBeenCalled();
});
