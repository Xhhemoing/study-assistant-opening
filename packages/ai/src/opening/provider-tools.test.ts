import { describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "./provider";
const base = { instruction: "readonly", text: "what courses?", mode: "listen" as const, chunks: [], maxOutputTokens: 100,
  mediaCapability: "text_only" as const, imageParts: [] };
const tools = [{ name: "courses", description: "read courses", parameters: { type: "object", properties: {}, additionalProperties: false } }];
const native = { id: "c1", type: "function", function: { name: "courses", arguments: "{}" } };
const response = (calls: unknown[], finish_reason = "tool_calls") => new Response(JSON.stringify({ id: "r1",
  choices: [{ finish_reason, message: { content: null, tool_calls: calls } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }), { headers: { "content-type": "application/json" } });
function provider(fetchImpl: typeof fetch) { return createOpeningProvider({ baseUrl: "https://model.example", apiKey: "fixture", model: "fixture", fetchImpl }); }
describe("OpenAI-compatible native tool transport", () => {
  it("sends native definitions and exact assistant/tool transcript ids, without JSON response mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([native]));
    const result = await provider(fetchImpl).complete({ ...base, tools, toolMessages: [
      { role: "assistant", calls: [{ id: "earlier", name: "courses", arguments: "{}" }] },
      { role: "tool", callId: "earlier", text: "untrusted source text" },
    ] });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.tools).toEqual([{ type: "function", function: tools[0] }]);
    expect(body).not.toHaveProperty("response_format");
    expect(body.messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "earlier", type: "function" }] });
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "earlier", content: "untrusted source text" });
    expect(result).toMatchObject({ text: "", toolCalls: [{ id: "c1", name: "courses", arguments: "{}" }], inputTokens: 12, outputTokens: 4 });
  });
  it.each([
    [null], [native, native], [{ ...native, function: { name: "sql", arguments: "{}" } }],
    [{ ...native, type: "other" }], [{ ...native, function: { name: "courses", arguments: "X".repeat(4001) } }],
  ].map(calls => [calls]))("rejects malformed/duplicate/unregistered provider calls %#", async calls => {
    await expect(provider(vi.fn().mockResolvedValue(response(calls))).complete({ ...base, tools })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
  });
  it("rejects unsolicited tool calls and truncated arguments", async () => {
    await expect(provider(vi.fn().mockResolvedValue(response([native]))).complete(base)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
    await expect(provider(vi.fn().mockResolvedValue(response([native], "length"))).complete({ ...base, tools })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
  });
  it("does not silently replay a request to discover unsupported tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unsupported tools", { status: 400 }));
    await expect(provider(fetchImpl).complete({ ...base, tools })).rejects.toMatchObject({ code: "PROVIDER_REQUEST" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
