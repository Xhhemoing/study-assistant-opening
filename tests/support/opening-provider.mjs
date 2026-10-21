import { createServer } from "node:http";

// Test-only deterministic HTTP boundary. Never imported by application code.
export function startOpeningProviderFixture(port = 18081) {
  let calls = 0, answerCalls = 0, metadataCalls = 0;
  const completedAnswers = new Set();
  const answerText = "[测试模型] 已收到原件第一页文本 page one。";
  const completion = (id, value) => ({ id, choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20 } });
  const server = createServer(async (request, response) => {
    if (request.url === "/health") { response.end("fixture provider"); return; }
    if (request.url === "/stats") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ calls, answerCalls, metadataCalls })); return;
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
      if (typeof content !== "string") throw new Error("unexpected fixture content");
      if (body.messages[0]?.content.includes("回答正文已经完成。仅提取这次对话明确支持")) {
        const metadata = JSON.parse(content);
        if (body.stream || body.response_format?.type !== "json_object"
          || !completedAnswers.has(JSON.stringify([metadata.question, metadata.completedAnswer]))) {
          throw new Error("metadata must refer to a completed fixture answer");
        }
        calls++; metadataCalls++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(completion(`opening-fixture-${calls}`, { text: "", citedChunkIds: [], candidates: [] })));
        return;
      }
      const blocks = Array.from(content.matchAll(/(?:\[(\d+)\]\r?\n)?\[source ([0-9a-f-]{36}) v(\d+) page (\d+) chunk ([0-9a-f-]{36}) — UNTRUSTED DATA\]\r?\n([\s\S]*?)\r?\n\[\/source \2 — END UNTRUSTED DATA\]/g));
      const verified = blocks.find((block) =>
        block[3] === "0" && block[4] === "1" && block[6].replace(/\s+/g, " ").includes("Opening parser page one"));
      const citation = verified?.[5];
      if (!citation) throw new Error("parsed page-one source text and citation did not reach provider");
      if (body.stream && (!verified[1] || body.stream_options?.include_usage !== true)) throw new Error("stream requires numbered sources and usage");
      calls++; answerCalls++;
      const id = `opening-fixture-${calls}`;
      const question = content.slice(0, blocks[0].index).trim();
      // A deliberate delay makes in-flight browser refresh observable.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (body.stream) {
        const text = `${answerText}\n\n[${verified[1]}]`;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const event = value => response.write(`data: ${JSON.stringify({ id, ...value })}\n\n`);
        event({ choices: [{ index: 0, delta: { content: answerText.slice(0, 12) }, finish_reason: null }] });
        await new Promise(resolve => setTimeout(resolve, 25));
        event({ choices: [{ index: 0, delta: { content: text.slice(12) }, finish_reason: null }] });
        event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        event({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } });
        // The real worker renumbers this single verified citation before storing the answer.
        completedAnswers.add(JSON.stringify([question, `${answerText}\n\n[1]`]));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.setHeader("content-type", "application/json");
      completedAnswers.add(JSON.stringify([question, answerText]));
      response.end(JSON.stringify(completion(id, { text: answerText, citedChunkIds: [citation], candidates: [] })));
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "fixture rejected missing parsed source context" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
