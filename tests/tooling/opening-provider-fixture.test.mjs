import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { startOpeningProviderFixture } from "../support/opening-provider.mjs";

const source = "00000000-0000-4000-8000-000000000001";
const chunk = "00000000-0000-4000-8000-000000000002";
const otherChunk = "00000000-0000-4000-8000-000000000003";
function block(text, { page = 1, version = 0, id = chunk, end = source } = {}) {
  return `[source ${source} v${version} page ${page} chunk ${id} — UNTRUSTED DATA]\n${text}\n[/source ${end} — END UNTRUSTED DATA]`;
}
// Port 0 can allocate a port blocked by Fetch, so use Node's HTTP client.
function requestFixture(url, { body, ...options } = {}) {
  return new Promise((resolve, reject) => {
    // Each fixture is short-lived; never reuse a previous fixture's socket.
    const req = request(url, { ...options, agent: false }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: async () => JSON.parse(raw) }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function fixture(t) {
  const server = await startOpeningProviderFixture(0);
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    submit: (content, options = {}) => requestFixture(`${url}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer opening-e2e-fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "opening-e2e-fixture", messages: [{ role: "user", content }], ...options }),
    }),
    stats: async () => (await requestFixture(`${url}/stats`)).json(),
  };
}
for (const [name, content] of [
  ["question contains the expected words but source text does not", `What does page one say?\n\n${block("unrelated text")}`],
  ["expected text belongs to another page", block("Opening parser page one", { page: 2 })],
  ["expected text belongs to another version", block("Opening parser page one", { version: 1 })],
  ["expected text occurs outside the source block", `${block("unrelated text")}\nOpening parser page one`],
  ["source closing marker does not match", block("Opening parser page one", { end: otherChunk })],
]) {
  test(`fixture rejects when ${name}`, async (t) => {
    const provider = await fixture(t);
    const response = await provider.submit(content);
    assert.equal(response.status, 400);
    assert.deepEqual(await provider.stats(), { calls: 0, answerCalls: 0, metadataCalls: 0 });
  });
}
test("fixture cites only the verified page-one block, even when it is not first", async (t) => {
  const provider = await fixture(t);
  const content = `Summarize the selected page.\n\n${block("Opening parser page two", { page: 2 })}\n${block("Opening parser page one", { id: otherChunk })}`;
  const response = await provider.submit(content);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(JSON.parse(body.choices[0].message.content).citedChunkIds, [otherChunk]);
  assert.deepEqual(await provider.stats(), { calls: 1, answerCalls: 1, metadataCalls: 0 });
});

test("fixture rejects streaming without numbered source citations and metadata without a completed answer", async t => {
  const provider = await fixture(t);
  const streaming = await provider.submit(block("Opening parser page one"), { stream: true, stream_options: { include_usage: true } });
  assert.equal(streaming.status, 400);
  const metadata = await provider.submit("", { response_format: { type: "json_object" }, messages: [
    { role: "system", content: "回答正文已经完成。仅提取这次对话明确支持的建议" },
    { role: "user", content: JSON.stringify({ question: "Summarize the selected page.", completedAnswer: "invented answer" }) },
  ] });
  assert.equal(metadata.status, 400);
  assert.deepEqual(await provider.stats(), { calls: 0, answerCalls: 0, metadataCalls: 0 });
});

test("real provider decodes fixture Markdown SSE, fixed-version citations and the separate metadata call", async t => {
  const previous = { NODE_ENV: process.env.NODE_ENV, OPENING_PROVIDER_ALLOW_LOCAL: process.env.OPENING_PROVIDER_ALLOW_LOCAL };
  process.env.NODE_ENV = "test"; process.env.OPENING_PROVIDER_ALLOW_LOCAL = "1";
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const fixtureProvider = await fixture(t);
  const { createOpeningProvider } = await tsImport("../../packages/ai/src/opening/provider.ts", import.meta.url);
  const { buildTutorMetadataInput, tutorCitationsFromMarkdown } = await tsImport("../../packages/ai/src/opening/tutor-metadata.ts", import.meta.url);
  const provider = createOpeningProvider({ baseUrl: `${fixtureProvider.url}/v1`, apiKey: "opening-e2e-fixture-key", model: "opening-e2e-fixture" });
  const chunks = [
    { id: chunk, sourceId: source, sourceVersion: 0, page: 2, text: "Opening parser page two", startMs: null, endMs: null, imageObjectKey: null },
    { id: otherChunk, sourceId: source, sourceVersion: 0, page: 1, text: "Opening parser page one", startMs: null, endMs: null, imageObjectKey: null },
  ];
  const input = { instruction: "Summarize the cited page", text: "Summarize the selected page.", chunks, mode: "hint", maxOutputTokens: 256,
    mediaCapability: "text_only", imageParts: [], outputFormat: "markdown" };
  const deltas = [];
  const output = await provider.complete(input, undefined, text => { deltas.push(text); });
  assert.equal(deltas.length, 2);
  assert.equal(output.text, "[测试模型] 已收到原件第一页文本 page one。\n\n[2]");
  assert.equal(deltas.join(""), output.text);
  assert.equal(output.inputTokens, 80); assert.equal(output.outputTokens, 20);
  const answer = tutorCitationsFromMarkdown(output.text, chunks);
  assert.equal(answer.text, "[测试模型] 已收到原件第一页文本 page one。\n\n[1]");
  assert.deepEqual(answer.citedChunkIds, [otherChunk]);
  assert.equal(answer.citations[0].sourceVersion, 0); assert.equal(answer.citations[0].page, 1);
  assert.deepEqual(await fixtureProvider.stats(), { calls: 1, answerCalls: 1, metadataCalls: 0 });
  const metadata = await provider.complete(buildTutorMetadataInput(input, answer.text));
  assert.equal(metadata.text, ""); assert.deepEqual(metadata.candidates, []);
  assert.equal(metadata.inputTokens, 80); assert.equal(metadata.outputTokens, 20);
  assert.deepEqual(await fixtureProvider.stats(), { calls: 2, answerCalls: 1, metadataCalls: 1 });
});
