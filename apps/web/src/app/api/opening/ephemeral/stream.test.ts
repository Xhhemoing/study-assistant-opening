import { beforeEach, expect, it, vi } from "vitest";
import { EphemeralServiceError } from "../../../../features/opening/tutor/ephemeral-service";

const mocks = vi.hoisted(() => ({ reply: vi.fn(), scope: { workspaceId: "workspace", ownerUserId: "owner" } }));
vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: async () => ({ scope: mocks.scope, sql: {} }),
  getEphemeralTutorService: () => ({ replyEphemeral: mocks.reply }),
}));
vi.mock("../../../../features/opening/server/data-services", () => ({ isOpeningDataError: () => false }));
import { POST } from "./route";

beforeEach(() => vi.resetAllMocks());
const request = () => new Request("http://localhost/api/opening/ephemeral", {
  method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ text: "提示" }),
});

it("delivers a delta before the temporary request completes, then the complete response", async () => {
  let finish!: (value: unknown) => void;
  mocks.reply.mockImplementation(async (_scope, _body, _signal, emit) => {
    await emit("先看这个系数");
    return new Promise(resolve => { finish = resolve; });
  });
  const response = await POST(request());
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const first = await reader.read();
  expect(decoder.decode(first.value)).toContain('event: delta\ndata: {"delta":"先看这个系数"}');
  finish({ text: "先看这个系数。", citations: [], candidates: [] });
  const last = await reader.read();
  expect(decoder.decode(last.value)).toContain("event: complete");
  expect((await reader.read()).done).toBe(true);
});

it("cancels upstream when the client closes its stream", async () => {
  let seen: AbortSignal | undefined;
  mocks.reply.mockImplementation(async (_scope, _body, signal: AbortSignal, emit) => {
    seen = signal;
    await emit("正在解释");
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const response = await POST(request()), reader = response.body!.getReader();
  await reader.read(); await reader.cancel();
  expect(seen?.aborted).toBe(true);
});

it("sends a structured failure without a fake complete event", async () => {
  mocks.reply.mockRejectedValue(new EphemeralServiceError("PRIVACY_CHANGED", "隐私设置已变化", 409));
  const response = await POST(request());
  const text = await response.text();
  expect(text).toContain("event: error");
  expect(text).toContain('"code":"PRIVACY_CHANGED"');
  expect(text).not.toContain("event: complete");
});
