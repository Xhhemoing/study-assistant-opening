import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningLearningAdviceService, parseLearningAdviceRequest } from "./learning-advice-service";

const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const scope = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4" };
const input = { attemptId, expectedRevision: 1, optIn: false };
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request("https://study.example/api/advice", { method: "POST", headers: {
    origin: "https://study.example", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
describe("learning advice bounded request", () => {
  beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PUBLIC_BASE_URL", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses the configured public base rather than the internal proxy URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", " https://study.example ");
    const proxied = new Request("http://localhost:18090/api/advice", { method: "POST",
      headers: { origin: "https://study.example", "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(await parseLearningAdviceRequest(proxied, activityId)).toEqual(input);
  });
  it.each(["http://localhost:18090", "https://evil.example", "null", "not-an-origin", ""])(
    "does not trust the internal URL or invalid/foreign origin with a configured public base: %s", async origin => {
      vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_BASE_URL", "https://study.example");
      await expect(parseLearningAdviceRequest(new Request("http://localhost:18090/api/advice", { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) }), activityId))
        .rejects.toMatchObject({ status: 400 });
    });
  it("fails closed when production has no configured base, even for a matching request origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(parseLearningAdviceRequest(request(), activityId)).rejects.toMatchObject({ status: 400 });
  });
  it("preserves the unified loopback equivalence only for the selected nonproduction base", async () => {
    const local = new Request("http://localhost:18090/api/advice", { method: "POST",
      headers: { origin: "http://127.0.0.1:18090", "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(await parseLearningAdviceRequest(local, activityId)).toEqual(input);
  });
  it("accepts an explicit same-origin real Request", async () => {
    expect(await parseLearningAdviceRequest(request(), activityId)).toEqual(input);
  });
  it.each(["trustedHost", "ownerUserId", "workspaceId", "enabled", "cutoff", "family", "ruleInput", "grant"])("rejects scope/grant injection: %s", async key => {
    await expect(parseLearningAdviceRequest(request({ ...input, [key]: true }), activityId)).rejects.toMatchObject({ status: 400 });
  });
  it.each([{ ...input, optIn: undefined }, { ...input, optIn: "true" }, { ...input, expectedRevision: 0 },
    { ...input, expectedRevision: 1.5 }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...input, attemptId: "catalog-key" }])("rejects incomplete/invalid input %j", async body => {
    await expect(parseLearningAdviceRequest(request(body), activityId)).rejects.toMatchObject({ status: 400 });
  });
  it.each<Record<string, string>>([{ origin: "https://evil.example" }, { origin: "null" }, { "content-type": "text/plain" },
    { "content-length": "4097" }, { "sec-fetch-site": "cross-site" }, { "content-encoding": "gzip" }])("rejects unsafe request metadata %j", async headers => {
    await expect(parseLearningAdviceRequest(request(input, headers), activityId)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects missing origin, bad route id, malformed JSON and oversized chunked UTF8", async () => {
    const missing = request(); missing.headers.delete("origin");
    await expect(parseLearningAdviceRequest(missing, activityId)).rejects.toMatchObject({ status: 400 });
    await expect(parseLearningAdviceRequest(request(), "bad")).rejects.toMatchObject({ status: 400 });
    const raw = (body: string) => new Request("https://study.example/api/advice", { method: "POST",
      headers: { origin: "https://study.example", "content-type": "application/json" }, body });
    await expect(parseLearningAdviceRequest(raw("{"), activityId)).rejects.toMatchObject({ status: 400 });
    await expect(parseLearningAdviceRequest(raw(`{"padding":"${"字".repeat(1500)}"}`), activityId)).rejects.toMatchObject({ status: 400 });
  });
});
describe("rule-only request-local advice", () => {
  it.each([false, true])("optIn=%s never enables an experiment or forwards opt-in to the repository", async optIn => {
    const read = vi.fn().mockResolvedValue({ ruleDecision: { activityKind: "diagnose", reasonCode: "no_evidence" },
      probability: 0.9, sourceIds: ["private"], preparation: "private" });
    const result = await createOpeningLearningAdviceService(read).read(scope, activityId, { ...input, optIn });
    expect(read).toHaveBeenCalledExactlyOnceWith(scope, { activityId, attemptId, expectedRevision: 1 });
    expect(result).toEqual({ advice: { ruleDecision: { activityKind: "diagnose", reasonCode: "no_evidence" },
      status: "disabled", experimentalAdvice: null }, experimentState: "off", messageCode: "rule_only" });
  });
  it("does not invent a rule or retain another request's rule on unavailable or failure", async () => {
    const first = createOpeningLearningAdviceService(vi.fn().mockResolvedValue({ ruleDecision: { activityKind: "diagnose", reasonCode: "no_evidence" } }));
    await first.read(scope, activityId, input);
    expect(await createOpeningLearningAdviceService(vi.fn().mockResolvedValue(null)).read(scope, activityId, input))
      .toEqual({ advice: null, experimentState: "off", messageCode: "advice_unavailable" });
    const error = new Error("DB unavailable");
    await expect(createOpeningLearningAdviceService(vi.fn().mockRejectedValue(error)).read(scope, activityId, input)).rejects.toBe(error);
  });
});
