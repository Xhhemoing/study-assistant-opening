import { createServer } from "node:http";

// Test-only deterministic HTTP boundary. Never imported by application code.
export function startOpeningProviderFixture(port = 18081) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/health") { response.end("fixture provider"); return; }
    if (request.url === "/stats") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ calls })); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" ||
        request.headers.authorization !== "Bearer opening-e2e-fixture-key") {
      response.writeHead(403).end(); return;
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("request exceeds fixture limit");
      }
      const body = JSON.parse(raw);
      if (body.model !== "opening-e2e-fixture") throw new Error("unexpected model");
      const content = body.messages.at(-1)?.content ?? "";
      const blocks = content.matchAll(/\[source ([0-9a-f-]{36}) v(\d+) page (\d+) chunk ([0-9a-f-]{36}) — UNTRUSTED DATA\]\r?\n([\s\S]*?)\r?\n\[\/source \1 — END UNTRUSTED DATA\]/g);
      const verified = Array.from(blocks).find((block) =>
        block[2] === "0" && block[3] === "1" && block[5].replace(/\s+/g, " ").includes("Opening parser page one"));
      const citation = verified?.[4];
      if (!citation) throw new Error("parsed page-one source text and citation did not reach provider");
      calls++;
      // A deliberate delay makes in-flight browser refresh observable.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: `opening-fixture-${calls}`, choices: [{ message: {
        content: JSON.stringify({ text: "[测试模型] 已收到原件第一页文本 page one。", citedChunkIds: [citation], candidates: [] }),
      } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }));
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "fixture rejected missing parsed source context" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
