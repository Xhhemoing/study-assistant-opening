// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageList } from "./message-list";
import { messagesWithStreamingReply, type ChatMessageView } from "./message-model";
import { useJobStream } from "./use-job-stream";

const encoder = new TextEncoder();
let host: HTMLDivElement, root: Root;
function channel() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel }), { headers: { "content-type": "text/event-stream" } });
  return { response, cancel, event(event: string, payload: Record<string, unknown>) {
    writer.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  } };
}
function Harness({ jobId = "job-one", conversationId = "conversation-one", turns = [] }: { jobId?: string | null; conversationId?: string; turns?: ChatMessageView[] }) {
  const { reply, cancel } = useJobStream(jobId, conversationId);
  return <><MessageList messages={messagesWithStreamingReply(turns, reply)} proseEnabled artifactsEnabled={false} /><button onClick={cancel}>取消</button></>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  document.documentElement.dataset.motion = "full";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete document.documentElement.dataset.motion;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

it("displays real partial Markdown before the job completes, then uses the persisted answer without replaying animation", async () => {
  const stream = channel();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(stream.response));
  const payload = { conversationId: "conversation-one", assistantTurnId: "turn-one" };
  const pending: ChatMessageView = { id: "turn-one", role: "assistant", text: "", citations: [], citationLabels: [], status: "pending" };
  await act(async () => root.render(<Harness turns={[pending]} />));
  stream.event("snapshot", { ...payload, sequence: 0, text: "" });
  stream.event("delta", { ...payload, sequence: 1, text: "先计算 **平方** $x" });
  await flush();
  expect(host.querySelector("strong")?.textContent).toBe("平方");
  expect(host.textContent).toContain("正在回答…");
  expect(host.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector(".opacity-0")).toBeNull();
  expect(host.querySelector('[data-reply-announcement="true"]')?.textContent).toBe("");
  stream.event("delta", { ...payload, sequence: 2, text: "^2$。" });
  await flush();
  expect(host.querySelector(".katex")).not.toBeNull();

  // A terminal event only ends transport; saved history remains the final authority.
  stream.event("terminal", { ...payload, status: "succeeded" });
  await flush();
  expect(host.textContent).not.toContain("已校正的最终回答");
  const complete: ChatMessageView = { ...pending, text: "已校正的最终回答。", status: "complete" };
  await act(async () => root.render(<Harness jobId={null} turns={[complete]} />));
  expect(host.textContent).toContain(complete.text);
  expect(host.textContent).not.toContain("先计算");
  expect(host.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("false");
  expect(host.querySelector("[data-reply-text-group]")).toBeNull();
  expect(host.querySelector('[data-reply-announcement="true"]')?.textContent).toBe(complete.text);
});

it("closes the old conversation stream immediately and never shows its cached text in the next conversation", async () => {
  const first = channel(), second = channel();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  vi.stubGlobal("fetch", fetchImpl);
  await act(async () => root.render(<Harness />));
  first.event("snapshot", { conversationId: "conversation-one", assistantTurnId: "turn-one", sequence: 4, text: "上一段对话" });
  await flush();
  expect(host.textContent).toContain("上一段对话");
  await act(async () => root.render(<Harness jobId="job-two" conversationId="conversation-two" />));
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("上一段对话");
  second.event("snapshot", { conversationId: "conversation-two", assistantTurnId: "turn-two", sequence: 2, text: "当前对话" });
  await flush();
  expect(host.textContent).toContain("当前对话");
  await act(async () => host.querySelector("button")!.click());
  expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  await flush();
  expect(second.cancel).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("does not overlay a provisional stream on a terminal saved turn", () => {
  const saved: ChatMessageView = { id: "turn-one", role: "assistant", text: "持久回答", citations: [], citationLabels: [], status: "complete" };
  expect(messagesWithStreamingReply([saved], { jobId: "job-one", conversationId: "conversation-one", assistantTurnId: "turn-one", text: "尚未处理的输出" })).toEqual([saved]);
});
