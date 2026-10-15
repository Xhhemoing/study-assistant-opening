import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { POST as quickSetup } from "../../../apps/web/src/app/api/opening/model-providers/quick-setup/route";
import { POST as probe } from "../../../apps/web/src/app/api/opening/model-providers/[id]/models/[modelId]/probe/route";
import { PUT as saveSettings } from "../../../apps/web/src/app/api/opening/ai-settings/route";
import { POST as createModel } from "../../../apps/web/src/app/api/opening/model-providers/[id]/models/route";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const secret = "quick-setup-test-private-key";
const input = { clientKey: "setup-request-1", label: "Gemini Free", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: secret,
  modelName: "gemini-2.5-flash", inputCentsPerMillion: 0, outputCentsPerMillion: 0, supportsAudio: true, supportsVision: true, billing: "free_tier", dailyRequestCap: 200 };
function req(body: unknown, cookie = f.cookie) { return new Request("https://localhost/api/opening/model-providers/quick-setup", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }); }

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await f.sql`DELETE FROM opening_model_providers WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`UPDATE workspace_preferences SET ai_settings=NULL WHERE workspace_id=${f.scope.workspaceId}`;
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
  vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "500");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) { await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close(); }
});

describe("quick setup keeps what other models rely on (R5)", () => {
  it("a free model keeps the confirmed cents cap, explicit fallbacks and the transcription engine", async () => {
    const confirmedAt = "2026-10-15T00:00:00.000Z";
    const paid = await quickSetup(req({ ...input, clientKey: "setup-paid-0001", label: "Lant", baseUrl: "https://lant.example/v1", modelName: "glm-5.3",
      billing: "metered", inputCentsPerMillion: 10, outputCentsPerMillion: 20, dailyRequestCap: null, dailyCapCents: 300, confirmBudget: true }));
    expect(paid.status).toBe(200);
    const paidModelId = (await paid.json()).settings.defaultModelId as string;
    await f.sql`UPDATE workspace_preferences SET ai_settings=jsonb_set(jsonb_set(jsonb_set(ai_settings,
      '{budgetConfirmedAt}', ${f.sql.json(confirmedAt)}),
      '{taskRoutes}', ${f.sql.json({ "teaching.compile": { primary: paidModelId, fallback: paidModelId } })}),
      '{transcription}', ${f.sql.json({ engine: "local" })}) WHERE workspace_id=${f.scope.workspaceId}`;
    const free = await quickSetup(req(input));
    expect(free.status).toBe(200);
    const data = await free.json();
    expect(data.settings).toMatchObject({ dailyCapCents: 300, budgetConfirmedAt: confirmedAt, transcription: { engine: "local" },
      taskRoutes: { "teaching.compile": { primary: null, fallback: paidModelId } } });
    expect(data.settings.defaultModelId).not.toBe(paidModelId);
    expect(data.models.find((model: { id: string }) => model.id === paidModelId)).toMatchObject({ availability: "available" });
  });
});

describe("atomic model quick setup", () => {
  it("requires auth and valid HTTPS, pricing, quota and budget confirmation", async () => {
    expect((await quickSetup(req(input, ""))).status).toBe(401);
    for (const patch of [{ baseUrl: "http://remote.example.com" }, { dailyRequestCap: 0 }, { billing: "metered" },
      { billing: "metered", inputCentsPerMillion: 2, outputCentsPerMillion: 3, dailyCapCents: 100, confirmBudget: false },
      { billing: "metered", inputCentsPerMillion: 2, outputCentsPerMillion: 3, dailyCapCents: 501, confirmBudget: true }]) {
      expect((await quickSetup(req({ ...input, ...patch }))).status).toBe(422);
    }
    expect(await f.sql`SELECT id FROM opening_model_providers WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });
  it("saves free quota without a monetary budget and serializes repeated client keys", async () => {
    const responses = await Promise.all([quickSetup(req(input)), quickSetup(req(input))]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(secret); expect(text).not.toContain("ciphertext");
      const data = JSON.parse(text);
      expect(data.settings).toMatchObject({ mode: "automatic", dailyCapCents: 0, budgetConfirmedAt: null });
      expect(data.settings).not.toHaveProperty("taskRoutes");
      expect(data.settings.routes).toEqual({ listen: null, hint: null, explain: null, think_together: null });
      expect(data.models.find((model: { id: string }) => model.id === data.settings.defaultModelId)).toMatchObject({ billing: "free_tier", supportsAudio: true, dailyRequestCap: 200 });
      expect(data.tasks.some((task: { key: string }) => task.key === "settings.probe")).toBe(false);
    }
    expect(await f.sql`SELECT id FROM opening_model_providers WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_model_provider_models WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  });
  it("records a confirmed metered budget and resets earlier routes", async () => {
    const response = await quickSetup(req({ ...input, billing: "metered", inputCentsPerMillion: 2, outputCentsPerMillion: 4, dailyCapCents: 100, confirmBudget: true }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.settings.dailyCapCents).toBe(100);
    expect(data.settings.budgetConfirmedAt).toEqual(expect.any(String));
  });
  it("rolls back the provider if credential encryption fails", async () => {
    vi.stubEnv("OPENING_CONNECTION_KEY", "");
    const response = await quickSetup(req(input));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
    expect(await f.sql`SELECT id FROM opening_model_providers WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });
  it("requires audio capability for model transcription and accepts an explicit audio fallback", async () => {
    const data = await (await quickSetup(req({ ...input, supportsAudio: false }))).json();
    const body = { ...data.settings, transcription: { engine: "model" } };
    expect((await saveSettings(new Request("https://localhost/api/opening/ai-settings", { method: "PUT", headers: { cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify(body) }))).status).toBe(422);
    const textModel = data.models.find((model: { id: string }) => model.id === data.settings.defaultModelId);
    const audio = await (await createModel(req({ label: "Audio", modelName: "audio", inputCentsPerMillion: 0, outputCentsPerMillion: 0, billing: "free_tier", dailyRequestCap: 200, supportsAudio: true }), { params: Promise.resolve({ id: textModel.providerId }) })).json();
    const response = await saveSettings(new Request("https://localhost/api/opening/ai-settings", { method: "PUT", headers: { cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify({ ...body, taskRoutes: { "media.transcribe": { primary: null, fallback: audio.id } } }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).settings.transcription.engine).toBe("model");
  });
  it.each(["model", "settings"])("rolls back all earlier writes if the %s insert fails", async (step) => {
    const table = step === "model" ? "opening_model_provider_models" : "workspace_preferences";
    // A real database failure after earlier inserts verifies transaction boundaries.
    await f.sql.unsafe(`CREATE FUNCTION test_abort_quick_setup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test fault'; END $$`);
    await f.sql.unsafe(`CREATE TRIGGER test_abort_quick_setup BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_abort_quick_setup()`);
    try {
      const response = await quickSetup(req(input));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(secret);
      expect(await f.sql`SELECT id FROM opening_model_providers WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      expect(await f.sql`SELECT id FROM opening_model_provider_models WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      const rows = await f.sql`SELECT ai_settings FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
      expect(rows[0]?.ai_settings ?? null).toBeNull();
    } finally {
      await f.sql.unsafe(`DROP TRIGGER test_abort_quick_setup ON ${table}`);
      await f.sql`DROP FUNCTION test_abort_quick_setup()`;
    }
  });
  it("probes the selected owned model through the ledger, without exposing provider errors", async () => {
    const data = await (await quickSetup(req(input))).json();
    const model = data.models.find((item: { id: string }) => item.id === data.settings.defaultModelId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 4 } }), { status: 200 }));
    const response = await probe(req({ clientKey: "probe-success-1" }), { params: Promise.resolve({ id: model.providerId, modelId: model.id }) });
    expect(await response.json()).toEqual({ ok: true, message: "本次请求成功。" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [entry] = await f.sql`SELECT purpose,amount_cents,state FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId} AND request_id=${`probe:${f.scope.workspaceId}:${model.id}:probe-success-1`}`;
    expect(entry).toMatchObject({ purpose: "probe", amount_cents: 0, state: "completed" });
    fetchMock.mockRejectedValue(new Error(secret));
    const failed = await probe(req({ clientKey: "probe-unknown-1" }), { params: Promise.resolve({ id: model.providerId, modelId: model.id }) });
    const failedText = await failed.text();
    expect(JSON.parse(failedText).ok).toBe(false); expect(failedText).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const foreign = await probe(req({ clientKey: "probe-foreign-1" }), { params: Promise.resolve({ id: f.otherScope.workspaceId, modelId: model.id }) });
    expect(foreign.status).toBe(404); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
