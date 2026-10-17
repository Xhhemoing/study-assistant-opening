import { describe, expect, it, vi } from "vitest";
import type { ExamSprintCommand, ExamSprintOverview } from "@aistudy/contracts";
import { createExamSprintClient } from "./client";

function overview(answered = 0): ExamSprintOverview {
  return {
    pack: { id: "math-i", version: "1", title: "考前冲刺", description: "", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: "2026-10-17T00:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
    attempts: [], activeRun: null, currentAttempt: null, skills: [], recommendations: [],
    summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: answered, onlineIndependentCorrect: 0 },
    workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const intent = { action: "answer", attemptId: "attempt-1", answer: "b", confidence: 3 } as const;
const key = "command-key-1";
type Fetcher = typeof fetch;

describe("exam sprint client recovery", () => {
  it("locks synchronously against double clicks and only generates one command key", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn<Fetcher>().mockReturnValue(response.promise);
    const keyFactory = vi.fn(() => key);
    const client = createExamSprintClient({ fetcher, keyFactory });
    const first = client.send(intent);
    const second = client.send(intent);
    expect(client.getSnapshot().busy).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(keyFactory).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(overview(1)));
    await Promise.all([first, second]);
    expect(client.getSnapshot()).toMatchObject({ busy: false, uncertain: false, error: null });
    expect(client.getSnapshot().overview?.summary.onlineAnswered).toBe(1);
  });

  it("reads after a lost response without resending; explicit recovery reuses the exact original command", async () => {
    const sent: ExamSprintCommand[] = [];
    const methods: string[] = [];
    let lost = true;
    const fetcher = vi.fn<Fetcher>(async (_url, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        if (lost) { lost = false; throw new TypeError("connection lost after commit"); }
      }
      return Response.json(overview(1));
    });
    const keyFactory = vi.fn(() => key);
    const client = createExamSprintClient({ fetcher, keyFactory });
    await client.send(intent);
    expect(client.getSnapshot()).toMatchObject({ busy: false, uncertain: true });
    await client.load();
    expect(methods).toEqual(["POST", "GET"]);
    expect(client.getSnapshot().uncertain).toBe(true);
    expect(client.getSnapshot().overview?.summary.onlineAnswered).toBe(1);
    await client.send({ action: "start", mode: "practice" });
    expect(methods).toEqual(["POST", "GET"]);
    await client.recover();
    expect(methods).toEqual(["POST", "GET", "GET", "POST"]);
    expect(sent).toEqual([{ ...intent, clientKey: key }, { ...intent, clientKey: key }]);
    expect(keyFactory).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({ busy: false, uncertain: false, error: null });
  });

  it("does not replay when recovery cannot read, and keeps the original write locked after recovery errors", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(Response.json({ error: "服务暂不可用" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(overview(1)))
      .mockResolvedValueOnce(Response.json({ error: "当前操作无法确认" }, { status: 409 }));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.send(intent);
    await client.recover();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot()).toMatchObject({ uncertain: true, busy: false });
    expect(client.getSnapshot().error).toContain("服务暂不可用");
    await client.recover();
    expect(client.getSnapshot().error).toContain("当前操作无法确认");
    await client.send({ action: "start", mode: "practice" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(client.getSnapshot().uncertain).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ ...intent, clientKey: key });
  });

  it("shows a known rejection and permits a fresh corrected action", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(Response.json({ error: { message: "请先完成当前题目" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(overview(1)));
    const keyFactory = vi.fn().mockReturnValueOnce(key).mockReturnValueOnce("command-key-2");
    const client = createExamSprintClient({ fetcher, keyFactory });
    await client.send({ action: "next", runId: "run-1" });
    expect(client.getSnapshot()).toMatchObject({ uncertain: false, busy: false, error: "请先完成当前题目" });
    await client.send(intent);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ ...intent, clientKey: "command-key-2" });
    expect(client.getSnapshot().error).toBeNull();
  });

  it.each([
    ["invalid JSON", () => new Response("not json")],
    ["incomplete data", () => Response.json({ state: {} })],
    ["malformed nested data", () => Response.json({ ...overview(), pack: { ...overview().pack, lessons: [{ title: "missing content" }] } })],
    ["server error", () => new Response("upstream unavailable", { status: 502 })],
  ])("keeps the original command after %s instead of treating it as a successful save", async (_label, response) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(response());
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.send(intent);
    expect(client.getSnapshot()).toMatchObject({ uncertain: true, overview: null, busy: false });
    expect(client.getSnapshot().error).toBeTruthy();
    await client.send(intent);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("exam sprint read lifecycle", () => {
  it("aborts a superseded read and ignores late responses even if fetch ignores cancellation", async () => {
    const older = deferred<Response>();
    const fetcher = vi.fn<Fetcher>().mockReturnValueOnce(older.promise).mockResolvedValueOnce(Response.json(overview(2)));
    const client = createExamSprintClient({ fetcher });
    const first = client.load();
    const firstSignal = fetcher.mock.calls[0]?.[1]?.signal;
    await client.load();
    expect(firstSignal?.aborted).toBe(true);
    older.resolve(Response.json(overview(1)));
    await first;
    expect(client.getSnapshot().overview?.summary.onlineAnswered).toBe(2);
    expect(client.getSnapshot().busy).toBe(false);
  });

  it("supports cleanup followed by remount and never renders the disposed request", async () => {
    const older = deferred<Response>();
    const fetcher = vi.fn<Fetcher>().mockReturnValueOnce(older.promise).mockResolvedValueOnce(Response.json(overview(2)));
    const client = createExamSprintClient({ fetcher });
    const first = client.load();
    client.dispose();
    await client.load();
    older.reject(new Error("late cancellation"));
    await first;
    expect(client.getSnapshot()).toMatchObject({ busy: false, uncertain: false, error: null });
    expect(client.getSnapshot().overview?.summary.onlineAnswered).toBe(2);
  });

  it("retains interrupted POST identity across cleanup and ignores its late completion", async () => {
    const older = deferred<Response>();
    const fetcher = vi.fn<Fetcher>()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(Response.json(overview(1)))
      .mockResolvedValueOnce(Response.json(overview(1)))
      .mockResolvedValueOnce(Response.json(overview(1)));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    const first = client.send(intent);
    client.dispose();
    await client.load();
    older.resolve(Response.json(overview(0)));
    await first;
    expect(client.getSnapshot().uncertain).toBe(true);
    expect(client.getSnapshot().overview?.summary.onlineAnswered).toBe(1);
    await client.recover();
    expect(client.getSnapshot().uncertain).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ ...intent, clientKey: key });
  });

  it("keeps a stable snapshot between changes and stops notifying unsubscribed listeners", async () => {
    const client = createExamSprintClient({ fetcher: vi.fn<Fetcher>().mockResolvedValue(Response.json(overview())) });
    expect(client.getSnapshot()).toBe(client.getSnapshot());
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await client.load();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    client.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});
