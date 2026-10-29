import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dialogueFixtureSchema } from "../../packages/domain/src/opening/tutor-dialogue-evaluation";
import { assertDialogueDatabase, collectTutorDialogue } from "../../scripts/lib/tutor-dialogue";

const load = async () => dialogueFixtureSchema.parse(JSON.parse(await readFile("tests/fixtures/opening/tutor-dialogue-cases.json", "utf8")));
const base = { git: "controlled-test-checkout", model: "controlled-model", baseUrl: "https://offline.invalid", apiKey: "synthetic-test-key" };
describe("dialogue database guard without connecting", () => {
  afterEach(() => vi.unstubAllEnvs());
  const controlledFetch = async () => new Response();
  const isolatedUrl = "postgres://synthetic:synthetic@127.0.0.1:5432/aistudy_opening_test";
  it("allows the CI default port only for an injected fetch and preserves the real-collection port guard", () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("OPENING_TEST_DB", "1");
    vi.stubEnv("OPENING_TEST_DB_SCRATCH_NAME", "");
    vi.stubEnv("OPENING_TEST_DATABASE_URL", isolatedUrl);
    expect(assertDialogueDatabase(controlledFetch).port).toBe("5432");
    expect(() => assertDialogueDatabase()).toThrow("non-default");
    vi.stubEnv("OPENING_TEST_DATABASE_URL", isolatedUrl.replace(":5432", ""));
    expect(() => assertDialogueDatabase()).toThrow("non-default");
    vi.stubEnv("OPENING_TEST_DATABASE_URL", isolatedUrl.replace(":5432", ":55438"));
    expect(assertDialogueDatabase().port).toBe("55438");
  });
  it.each(["wrong_name", "remote_host", "production", "missing_opt_in"])("rejects %s even with controlled fetch", kind => {
    vi.stubEnv("NODE_ENV", kind === "production" ? "production" : "test");
    vi.stubEnv("OPENING_TEST_DB", kind === "missing_opt_in" ? "0" : "1");
    vi.stubEnv("OPENING_TEST_DB_SCRATCH_NAME", "");
    vi.stubEnv("OPENING_TEST_DATABASE_URL", kind === "wrong_name" ? isolatedUrl.replace("aistudy_opening_test", "aistudy")
      : kind === "remote_host" ? isolatedUrl.replace("127.0.0.1", "db.example.invalid") : isolatedUrl);
    expect(() => assertDialogueDatabase(controlledFetch)).toThrow();
    expect(() => assertDialogueDatabase()).toThrow();
  });
});
describe("real Worker/database/provider dialogue with fetch-only replacement", () => {
  it("delivers two real rounds, preserves history/snapshots/help, replays once, and checks all three scenarios", async () => {
    const fixture = await load();
    let calls = 0;
    const texts = ["先在等式两边都减去4，你会得到什么？", "我的下一步是两边减4，得到3x=21。", "对，接下来两边除以3，请你算。", "两边减5得到2y=18，再除以2，y = 9。", "尚未保存，也没有安排；我无法确认你已掌握。"];
    const report = await collectTutorDialogue({ ...base, cases: fixture.cases, fixtureVersion: fixture.version, maxRequests: 5,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        if (calls === 1) {
          const student = JSON.parse(body.messages.at(-1)!.content.trim()) as Record<string, unknown>;
          expect(Object.keys(student).sort()).toEqual(["deliveredTutor", "limitedKnowledge", "problem"]);
          expect(body.messages.some(row => row.content.includes("answerStrings"))).toBe(false);
        }
        if (calls === 2) expect(body.messages.slice(1, 3)).toEqual([
          { role: "user", content: fixture.cases[0]!.firstUser }, { role: "assistant", content: texts[0] },
        ]);
        const id = `controlled-${++calls}`;
        const answer = JSON.stringify({ text: texts[calls - 1], citedChunkIds: [], candidates: [] });
        const content = calls === 1 ? texts[0] : calls === 3 ? `\`\`\`json\n${answer}\n\`\`\`` : calls === 4 ? `说明：${answer}以上是解答。` : answer;
        return new Response(JSON.stringify({ id, choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
      } });
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.requests).toHaveLength(5);
    expect(report.cases).toHaveLength(3);
    expect(report.requests.map(row => row.output?.requestId)).toEqual([1, 2, 3, 4, 5].map(n => `controlled-${n}`));
    expect(report.cases[2]!.turns).toEqual(expect.arrayContaining([expect.objectContaining({ generatedOnly: "not_applicable", released: "not_applicable" })]));
  }, 30000);
  it.each(["json", "fenced", "wrapped"])("retains provider rejection and detects the restricted answer in raw %s content", async format => {
    const fixture = await load();
    const item = { ...fixture.cases[0]!, studentFollowup: false };
    const answer = JSON.stringify({ text: "尚未保存，请先两边减去4。", answer: "hidden", citedChunkIds: [], candidates: [] });
    const content = format === "fenced" ? `\`\`\`json\n${answer}\n\`\`\`` : format === "wrapped" ? `说明：\n${answer}\n以上是提示。` : answer;
    const report = await collectTutorDialogue({ ...base, cases: [item], fixtureVersion: fixture.version, maxRequests: 1,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })) });
    expect(report.errors).toEqual(["hint-linear-attempt:OpeningProviderError:PROVIDER_RESPONSE"]);
    expect(report.requests[0]!.output).toBeUndefined();
    expect(report.cases[0]!.turns).toEqual([expect.objectContaining({ evaluation: expect.objectContaining({
      status: "error", risks: ["restricted_answer_field"],
    }) })]);
    expect(report.passed).toBe(false);
  }, 30000);
  it("retains raw HTTP failures and missing planned turns without retry", async () => {
    const fixture = await load();
    const report = await collectTutorDialogue({ ...base, cases: [fixture.cases[0]!], fixtureVersion: fixture.version, maxRequests: 3,
      fetchImpl: async () => new Response('provider failed synthetic', { status: 503 }) });
    expect(report.passed).toBe(false); expect(report.requests).toHaveLength(1);
    expect(report.requests[0]).toMatchObject({ status: 503, raw: "provider failed synthetic" });
    expect(report.cases[0]!.turns).toHaveLength(2);
  }, 30000);
  it("counts student against the hard request cap and preserves the second planned tutor slot", async () => {
    const fixture = await load(); let calls = 0;
    const report = await collectTutorDialogue({ ...base, cases: [fixture.cases[0]!], fixtureVersion: fixture.version, maxRequests: 1,
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "两边减去4再试。", citedChunkIds: [], candidates: [] }) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })); } });
    expect(calls).toBe(1); expect(report.requests).toHaveLength(1); expect(report.passed).toBe(false);
    expect(report.cases[0]!.requestLimitReached).toBe(true);
    expect(report.cases[0]!.turns).toHaveLength(2);
  }, 30000);
});
