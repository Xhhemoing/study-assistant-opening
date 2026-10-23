import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { GradingEvaluationDataset } from "@aistudy/contracts";
import { runGradingCollectionCli } from "../../../../scripts/study-grading-collect";
import { collectGradingRun, type GradingCollectionOptions } from "./grading-collection";
import { evaluateGradingRun } from "./grading-evaluation";

const privateAnswer = "private-student-answer";
const input = { question: "求 f(x)=x² 的导数。", answer: privateAnswer, referenceText: "f'(x)=2x", imageEvidenceRef: null };
function dataset(ids: string[] = ["first"]): GradingEvaluationDataset {
  return { protocolVersion: "grading-evaluation-v1", datasetId: "collection-test", datasetVersion: "1",
    cases: ids.map(id => ({ id, version: "1", group: "equivalent_solution", modality: "text", input,
      candidateOutcome: "incorrect", candidateRationale: "candidate-label-not-for-model",
      review: { status: "human_reviewed", reviewerId: "private-reviewer", reviewedAt: "2026-10-22T00:00:00.000Z",
        outcome: "correct", rationale: "private-human-rationale" } })) };
}
const grading = JSON.stringify({ outcome: "correct", confidence: 0.9, questionMatch: true, feedback: "等价写法。",
  criteria: [{ label: "求导", verdict: "correct", feedback: "导数正确。" }] });
const response = (content = grading, usage: unknown = undefined) => Response.json({ id: "fixture-response",
  choices: [{ message: { content } }], ...(usage ? { usage } : {}) });
const options = (fetchImpl: typeof fetch, extra: Partial<GradingCollectionOptions> = {}): GradingCollectionOptions => ({
  baseUrl: "https://model.example/v1", model: "fixture-model", apiKey: "private-key", maxRequests: 2, fetchImpl, ...extra,
});
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

it("reuses grading instructions, omits reviewer truth and makes only serial bounded calls", async () => {
  let active = 0, maxActive = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    active += 1; maxActive = Math.max(maxActive, active);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("fixture-model");
    expect(body.max_tokens).toBe(3000);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("不是经过校准的正确概率");
    expect(JSON.parse(body.messages.at(-1).content.trim())).toEqual({ question: input.question, studentAnswer: privateAnswer, reference: input.referenceText });
    for (const privateLabel of ["candidate-label-not-for-model", "private-human-rationale", "private-reviewer"]) expect(String(init?.body)).not.toContain(privateLabel);
    await Promise.resolve(); active -= 1;
    return response(` ${grading}\n`, { prompt_tokens: 12, completion_tokens: 34 });
  });
  const result = await collectGradingRun(dataset(["first", "second", "third"]), options(transport));
  expect(maxActive).toBe(1); expect(transport).toHaveBeenCalledTimes(2);
  expect(result.run.provenance).toBe("test_fixture");
  expect(result.run.results).toHaveLength(3);
  expect(result.run.results[0]?.rawOutput).toBe(grading);
  expect(result.collection.cases[0]).toMatchObject({ rawMessageContent: ` ${grading}\n`, rawMessageLength: grading.length + 2,
    requestId: "fixture-response", inputTokens: 12, outputTokens: 34, elapsedMs: expect.any(Number) });
  expect(result.collection.elapsedMs).toBeGreaterThanOrEqual(result.collection.cases[0]!.elapsedMs!);
  expect(result.collection.cases.map(row => row.status)).toEqual(["valid_output", "valid_output", "request_limit_reached"]);
  expect(result.collection).toMatchObject({ requestCount: 2, maxRequests: 2, status: "completed", textOnly: true });
  expect(evaluateGradingRun(dataset(["first", "second", "third"]), result.run).summary).toMatchObject({ validResults: 2, missingOrInvalidResults: 1, coverage: 2 / 3 });
});

it("retains malformed JSON and HTTP failures without retrying or leaking error bodies", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(response("not JSON"))
    .mockResolvedValueOnce(Response.json({ error: "private-key private-student-answer" }, { status: 503 }))
    .mockResolvedValueOnce(response());
  const data = dataset(["invalid", "failed", "valid"]);
  const result = await collectGradingRun(data, options(transport, { maxRequests: 3 }));
  expect(transport).toHaveBeenCalledTimes(3);
  expect(result.collection.cases.map(row => row.status)).toEqual(["invalid_model_output", "provider_error", "valid_output"]);
  expect(result.run.results.map(row => row.rawOutput)).toEqual(["", "", grading]);
  expect(result.collection.cases[0]?.rawMessageContent).toBe("not JSON");
  expect(JSON.stringify(result.collection)).not.toContain("private-key");
  expect(evaluateGradingRun(data, result.run).summary).toMatchObject({ validResults: 1, missingOrInvalidResults: 2, coverage: 1 / 3 });
});

it("never sends a photo without supporting assets or counts a photo as a text test", async () => {
  const data = dataset(["photo", "text"]);
  data.cases[0] = { ...data.cases[0]!, modality: "photo", input: { ...input, imageEvidenceRef: "operator-photo-v1" } };
  const transport = vi.fn<typeof fetch>(async () => response());
  const result = await collectGradingRun(data, options(transport, { maxRequests: 1 }));
  expect(transport).toHaveBeenCalledOnce();
  expect(result.collection.cases.map(row => row.status)).toEqual(["photo_not_supported", "valid_output"]);
  expect(result.run.results[0]).toMatchObject({ caseId: "photo", input: { imageEvidenceRef: "operator-photo-v1" }, rawOutput: "" });
  expect(result.collection.cases[0]).toMatchObject({ requestId: null, inputTokens: null, outputTokens: null, elapsedMs: null });
  expect(evaluateGradingRun(data, result.run).summary).toMatchObject({ verified: 2, validResults: 1, missingOrInvalidResults: 1 });
});

it("does not score valid-looking content if its provider envelope was rejected", async () => {
  const result = await collectGradingRun(dataset(), options(async () => response(grading, { prompt_tokens: -1, completion_tokens: 1 })));
  expect(result.run.results[0]?.rawOutput).toBe("");
  expect(result.collection.cases[0]).toMatchObject({ status: "provider_error", rawMessageContent: grading, inputTokens: null, outputTokens: 1 });
  expect(evaluateGradingRun(dataset(), result.run).summary.validResults).toBe(0);
});

it("scores the provider's normalized fenced JSON and retains the original message separately", async () => {
  const original = `\`\`\`json\n${grading}\n\`\`\``;
  const result = await collectGradingRun(dataset(), options(async () => response(original)));
  expect(result.run.results[0]?.rawOutput).toBe(grading);
  expect(result.collection.cases[0]).toMatchObject({ status: "valid_output", rawMessageContent: original,
    rawMessageLength: original.length, inputTokens: null, outputTokens: null });
  expect(evaluateGradingRun(dataset(), result.run).summary.validResults).toBe(1);
});

it("retains refusal and malformed-envelope failures even when their content resembles a valid grade", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "refusal-request",
    choices: [{ message: { content: grading, refusal: "provider refusal" } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }))
    .mockResolvedValueOnce(Response.json({ id: "malformed-request", choices: [], content: grading }));
  const data = dataset(["refused", "malformed"]);
  const result = await collectGradingRun(data, options(transport));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(result.run.results.map(row => row.rawOutput)).toEqual(["", ""]);
  expect(result.collection.cases[0]).toMatchObject({ status: "provider_error", errorCode: "PROVIDER_REFUSAL",
    rawMessageContent: grading, requestId: "refusal-request", inputTokens: 9, outputTokens: 2 });
  expect(result.collection.cases[1]).toMatchObject({ errorCode: "PROVIDER_RESPONSE", rawMessageContent: null,
    requestId: "malformed-request", inputTokens: null, outputTokens: null });
  expect(evaluateGradingRun(data, result.run).summary).toMatchObject({ validResults: 0, missingOrInvalidResults: 2 });
});

it("bounds oversized output and stops if saving a checkpoint fails", async () => {
  const transport = vi.fn<typeof fetch>(async () => response("x".repeat(80_001)));
  const result = await collectGradingRun(dataset(), options(transport));
  expect(result.run.results[0]?.rawOutput).toBe("");
  expect(result.collection.cases[0]).toMatchObject({ status: "invalid_model_output", errorCode: "COLLECTION_OUTPUT_TOO_LARGE", rawMessageLength: 80_001 });
  expect(result.collection.cases[0]?.rawMessageContent).toHaveLength(80_000);
  transport.mockClear();
  await expect(collectGradingRun(dataset(["first", "second"]), options(transport, {
    onProgress: async snapshot => { if (snapshot.collection.requestCount) throw new Error("checkpoint unavailable"); },
  }))).rejects.toThrow("checkpoint unavailable");
  expect(transport).toHaveBeenCalledOnce();
});

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "study-grading-collect-")); temporary.push(directory);
  const datasetPath = join(directory, "dataset.json"), output = join(directory, "run.json");
  await writeFile(datasetPath, JSON.stringify(dataset()));
  const args = ["--dataset", datasetPath, "--model", "fixture-model", "--base-url-env", "TEST_BASE", "--api-key-env", "TEST_KEY", "--max-requests", "1", "--output", output];
  return { datasetPath, output, args, environment: { TEST_BASE: "https://model.example/v1", TEST_KEY: "private-key" } };
}

it("writes private new result/checkpoint files without printing answers or credentials", async () => {
  const { datasetPath, output, args, environment } = await files();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const summary = await runGradingCollectionCli(args, environment, async () => response());
  expect(summary).toEqual({ requestCount: 1, validOutputs: 1, failed: 0, skipped: 0 });
  expect(log).not.toHaveBeenCalled();
  const result = JSON.parse(await readFile(output, "utf8"));
  const details = JSON.parse(await readFile(`${output}.collection.json`, "utf8"));
  expect(result).toMatchObject({ provenance: "test_fixture", results: [{ input, rawOutput: grading }] });
  expect(details.status).toBe("completed");
  expect(JSON.stringify(result)).not.toContain("private-key");
  if (process.platform !== "win32") {
    expect((await stat(output)).mode & 0o077).toBe(0);
    expect((await stat(`${output}.collection.json`)).mode & 0o077).toBe(0);
  }
  expect(JSON.parse(await readFile(datasetPath, "utf8"))).toEqual(dataset());
});

it("requires explicit settings and refuses existing results, metadata and input paths before any request", async () => {
  const { datasetPath, output, args, environment } = await files();
  const transport = vi.fn<typeof fetch>(async () => response());
  await expect(runGradingCollectionCli([], environment, transport)).rejects.toThrow("Missing required");
  await expect(runGradingCollectionCli(args, {}, transport)).rejects.toThrow("environment setting");
  await expect(runGradingCollectionCli(args.map(value => value === output ? datasetPath : value), environment, transport)).rejects.toThrow("overwrite input");
  await writeFile(output, "keep-result");
  await expect(runGradingCollectionCli(args, environment, transport)).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("keep-result");
  await rm(output);
  await writeFile(`${output}.collection.json`, "keep-metadata");
  await expect(runGradingCollectionCli(args, environment, transport)).rejects.toThrow();
  expect(await readFile(`${output}.collection.json`, "utf8")).toBe("keep-metadata");
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(transport).not.toHaveBeenCalled();
});
