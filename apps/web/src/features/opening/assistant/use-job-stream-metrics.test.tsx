// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useJobStream, type FirstTextTiming } from "./use-job-stream";
const mocks = vi.hoisted(() => ({ record: vi.fn(), reply: null as null | ((reply: { jobId: string; conversationId: string; assistantTurnId: string; text: string }) => void) }));
vi.mock("../client/learning-experience", () => ({ recordLearningExperience: mocks.record }));
vi.mock("./job-stream", () => ({ createJobStream: (options: { onReply: typeof mocks.reply }) => {
  mocks.reply = options.onReply; return { start() {}, cancel() {} };
} }));
let host: HTMLDivElement, root: Root;
const timing = { jobId: "job", clientKey: "submit-key", startedAt: 100 };
function Harness({ sample = timing as FirstTextTiming | null }) {
  const { reply } = useJobStream("job", "conversation", sample);
  return <p>{reply?.text}</p>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false); vi.spyOn(performance, "now").mockReturnValue(2400);
  mocks.record.mockReset().mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const delta = (text: string) => act(async () => { mocks.reply!({ jobId: "job", conversationId: "conversation", assistantTurnId: "turn", text }); });
it("records after committed nonempty text and the next frame, once per job", async () => {
  await act(async () => root.render(<Harness />));
  await delta(" "); await act(async () => vi.advanceTimersByTimeAsync(20)); expect(mocks.record).not.toHaveBeenCalled();
  await delta("第一行"); expect(host.textContent).toBe("第一行"); expect(mocks.record).not.toHaveBeenCalled();
  await delta("第一行和后续字"); await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ kind: "first_text", jobId: "job", clientKey: "submit-key", durationMs: 2300 });
  await delta("更多正文"); await act(async () => vi.advanceTimersByTimeAsync(20)); expect(mocks.record).toHaveBeenCalledTimes(1);
});
it.each([null, { ...timing, jobId: "previous" }])("does not invent a submission clock for restored or unrelated jobs", async sample => {
  await act(async () => root.render(<Harness sample={sample} />)); await delta("恢复的文字");
  await act(async () => vi.advanceTimersByTimeAsync(20)); expect(mocks.record).not.toHaveBeenCalled();
});
