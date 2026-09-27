import assert from "node:assert/strict";
import test from "node:test";
import { startOpeningProviderFixture } from "../support/opening-provider.mjs";

const source = "00000000-0000-4000-8000-000000000001";
const chunk = "00000000-0000-4000-8000-000000000002";
const otherChunk = "00000000-0000-4000-8000-000000000003";
function block(text, { page = 1, version = 0, id = chunk, end = source } = {}) {
  return `[source ${source} v${version} page ${page} chunk ${id} — UNTRUSTED DATA]\n${text}\n[/source ${end} — END UNTRUSTED DATA]`;
}
async function fixture(t) {
  const server = await startOpeningProviderFixture(0);
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    submit: (content) => fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer opening-e2e-fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "opening-e2e-fixture", messages: [{ role: "user", content }] }),
    }),
    stats: async () => (await fetch(`${url}/stats`)).json(),
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
    assert.deepEqual(await provider.stats(), { calls: 0 });
  });
}
test("fixture cites only the verified page-one block, even when it is not first", async (t) => {
  const provider = await fixture(t);
  const content = `Summarize the selected page.\n\n${block("Opening parser page two", { page: 2 })}\n${block("Opening parser page one", { id: otherChunk })}`;
  const response = await provider.submit(content);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(JSON.parse(body.choices[0].message.content).citedChunkIds, [otherChunk]);
  assert.deepEqual(await provider.stats(), { calls: 1 });
});
