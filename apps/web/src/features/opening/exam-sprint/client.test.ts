import { describe, expect, it, vi } from "vitest";
import type { ExamSprintCommand, ExamSprintOverview } from "@aistudy/contracts";
import { createExamSprintClient } from "./client";
import { confirmedSprintLesson, prepareSprintLesson } from "./lesson-navigation";

function overview(answered = 0): ExamSprintOverview {
  return {
    pack: { id: "math-i", version: "1", title: "考前冲刺", description: "", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: "2026-10-17T00:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
    lessonContents: [], attempts: [], activeRun: null, currentAttempt: null, skills: [], recommendations: [],
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

const lesson = { id: "lesson-1", topicId: "topic-1", title: "极限", summary: "摘要", steps: ["化简"], workedExample: "完整串讲正文", pitfalls: [] };
const lessonIdentity = { packVersion: "1", contentFingerprint: "reviewed-content", mappingVersion: "reviewed-map" };
const openLesson = { action: "open_lesson", lessonId: lesson.id, expectedRunId: null, expectedAttemptId: null, ...lessonIdentity } as const;
function lessonOverview(confirmed = false) {
  const data = overview();
  data.pack.lessons = [{ id: lesson.id, topicId: lesson.topicId, title: lesson.title, summary: lesson.summary, exposureIdentity: lessonIdentity }];
  if (confirmed) data.lessonContents = [{ exposureId: "exposure-1", lesson }];
  return data;
}
function activeLessonOverview(): ExamSprintOverview {
  const data = lessonOverview(true);
  const run = { id: "run-1", mode: "practice" as const, questionIds: ["question-1"], startedAt: data.state.startedAt, deadlineAt: null, completedAt: null };
  const attempt = { id: "attempt-1", runId: run.id, questionId: "question-1", presentedAt: run.startedAt, answeredAt: null, answer: null, correct: null, confidence: null, durationSeconds: null, help: [], errorCause: null, independent: false,
    question: { id: "question-1", topicId: lesson.topicId, skillId: "skill-1", familyId: "family-1", lessonId: lesson.id, difficulty: "foundation" as const, prompt: "题目", options: [{ id: "A", label: "答案" }], estimatedMinutes: 2 }, feedback: null, hint: null };
  data.state.runs = [run];
  data.activeRun = run;
  data.currentAttempt = attempt;
  data.attempts = [attempt];
  return data;
}

describe("exam sprint lesson confirmation", () => {
  it.each(["legacy_untracked_source", "unverifiable_source"] as const)("retains the server's %s coverage fact without inventing help or sending it back", async kind => {
    const data = activeLessonOverview();
    const coverage = { kind, packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 2 };
    data.currentAttempt!.exposureCoverage = coverage;
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(Response.json(data));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.load();
    expect(client.getSnapshot().overview?.currentAttempt?.exposureCoverage).toEqual(coverage);
    expect(client.getSnapshot().overview?.attempts[0]?.exposureCoverage).toEqual(coverage);
    expect(client.getSnapshot().overview?.currentAttempt?.help).toEqual([]);
    await client.send(intent);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ ...intent, clientKey: key });
  });

  it.each([
    { packSourceId: "not-a-uuid", sourceVersion: 2 },
    { packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: -1 },
    { packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 1.5 },
  ])("rejects malformed source coverage at the HTTP boundary: %j", async fields => {
    const data = activeLessonOverview();
    const malformed = { ...data, currentAttempt: { ...data.currentAttempt, exposureCoverage: { kind: "legacy_untracked_source", ...fields } } };
    const client = createExamSprintClient({ fetcher: vi.fn<Fetcher>().mockResolvedValue(Response.json(malformed)) });
    await client.load();
    expect(client.getSnapshot().overview).toBeNull();
    expect(client.getSnapshot().error).not.toBeNull();
  });

  it.each<[string, (data: ExamSprintOverview) => void]>([
    ["run", data => { data.activeRun!.id = "new-run"; data.currentAttempt!.runId = "new-run"; }],
    ["attempt", data => { data.currentAttempt!.id = "new-attempt"; }],
    ["pack", data => { data.pack.version = "2"; }],
    ["content", data => { data.pack.lessons[0]!.exposureIdentity = { ...lessonIdentity, contentFingerprint: "new-content" }; }],
    ["mapping", data => { data.pack.lessons[0]!.exposureIdentity = { ...lessonIdentity, mappingVersion: "new-map" }; }],
    ["unavailable mapping", data => { data.pack.lessons[0]!.exposureIdentity = null; }],
    ["mock", data => { data.activeRun!.mode = "mock-a"; data.lessonContents = []; }],
  ])("ends only the stale lost lesson navigation after a cross-tab %s change", async (_label, change) => {
    const original = activeLessonOverview();
    const request = prepareSprintLesson(original, lesson.id)!;
    const latest = activeLessonOverview();
    change(latest);
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(new Error("lost open response"))
      .mockResolvedValueOnce(Response.json(latest)).mockResolvedValueOnce(Response.json(latest));
    const keys = vi.fn().mockReturnValueOnce(key).mockReturnValueOnce("new-command-key");
    const client = createExamSprintClient({ fetcher, keyFactory: keys });
    expect(await client.send(request)).toBeNull();
    expect(client.getSnapshot().uncertain).toBe(true);
    const recovered = await client.recover();
    expect(recovered).not.toBeNull();
    expect(confirmedSprintLesson(recovered!, request)).toBeNull();
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    expect(client.getSnapshot()).toMatchObject({ uncertain: false, error: expect.stringContaining("题包内容刚更新过") });
    const fresh = prepareSprintLesson(recovered!, lesson.id);
    await client.send(fresh ?? { action: "configure", examDate: null, dailyMinutes: 60 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(keys).toHaveBeenCalledTimes(2);
  });

  it("waits for persisted confirmation and sends every reopening through the server", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(Response.json(lessonOverview())).mockReturnValueOnce(response.promise).mockResolvedValueOnce(Response.json(lessonOverview(true)));
    const keyFactory = vi.fn().mockReturnValueOnce(key).mockReturnValueOnce("command-key-2");
    const client = createExamSprintClient({ fetcher, keyFactory });
    await client.load();
    const first = client.send(openLesson);
    expect(client.getSnapshot().overview?.lessonContents).toEqual([]);
    expect(await client.send(openLesson)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    response.resolve(Response.json(lessonOverview(true)));
    expect((await first)?.lessonContents[0]!.lesson.workedExample).toBe(lesson.workedExample);
    await client.send(openLesson);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(keyFactory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ ...openLesson, clientKey: key });
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({ ...openLesson, clientKey: "command-key-2" });
  });

  it("keeps unknown opens on the original view and recovers the exact same command before returning content", async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(new Error("lost lesson response"))
      .mockResolvedValueOnce(Response.json(lessonOverview(true))).mockResolvedValueOnce(Response.json(lessonOverview(true)));
    const keys = vi.fn(() => key);
    const client = createExamSprintClient({ fetcher, keyFactory: keys });
    expect(await client.send(openLesson)).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ overview: null, uncertain: true });
    expect(await client.send(intent)).toBeNull();
    const restored = await client.recover();
    expect(restored?.lessonContents[0]!.exposureId).toBe("exposure-1");
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST"]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[2]![1]?.body);
    expect(keys).toHaveBeenCalledOnce();
  });

  it("does not disclose content on a rejected mock open or malformed acknowledgement", async () => {
    const malformed = { ...lessonOverview(true), lessonContents: [{ exposureId: "exposure-1", lesson: { id: lesson.id } }] };
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(Response.json({ error: "模拟交卷后才能阅读串讲" }, { status: 409 })).mockResolvedValueOnce(Response.json(malformed));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    expect(await client.send(openLesson)).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ overview: null, uncertain: false, error: "模拟交卷后才能阅读串讲" });
    expect(await client.send(openLesson)).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ overview: null, uncertain: true });
  });

  it("ignores a disposed late lesson acknowledgement and preserves its replay key", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn<Fetcher>().mockReturnValueOnce(response.promise).mockResolvedValueOnce(Response.json(lessonOverview()));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    const pending = client.send(openLesson);
    client.dispose();
    await client.load();
    response.resolve(Response.json(lessonOverview(true)));
    expect(await pending).toBeNull();
    expect(client.getSnapshot().overview?.lessonContents).toEqual([]);
    expect(client.getSnapshot().uncertain).toBe(true);
  });
});

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

const integration = {
  binding: null, links: [], bkt: { calibrated: false as const, eligible: 0, excluded: 0, bktBrier: null, baselineBrier: null, skills: [], message: "尚未校准" }, courseGoal: null, sourceMappings: [],
};
const bindInput = { courseId: "11111111-1111-4111-8111-111111111111", milestoneId: null, expectedPackVersion: "1", createKnowledgeNodes: true, skills: [], materials: [] };
const reviewInput = { sourceItemId: "source-item-1", workSourceId: "22222222-2222-4222-8222-222222222222", workSourceVersion: 1, referenceSourceId: "33333333-3333-4333-8333-333333333333", referenceSourceVersion: 2, answerText: "我的完整推导" };
const review = { id: "44444444-4444-4444-8444-444444444444", sourceItemId: reviewInput.sourceItemId, workSourceId: reviewInput.workSourceId, referenceSourceId: reviewInput.referenceSourceId, workSourceVersion: reviewInput.workSourceVersion, referenceSourceVersion: reviewInput.referenceSourceVersion, answerText: reviewInput.answerText, createdAt: "2026-10-17T12:00:00Z", status: "pending", proposal: null, modelLabel: null };

describe("exam integration shares mutation recovery", () => {
  it("blocks all write types after a lost binding response and replays the same binding key", async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(new Error("lost binding response"))
      .mockResolvedValueOnce(Response.json(integration)).mockResolvedValueOnce(Response.json(integration)).mockResolvedValueOnce(Response.json(integration));
    const keys = vi.fn(() => key);
    const client = createExamSprintClient({ fetcher, keyFactory: keys });
    await client.sendIntegration({ action: "bind", input: bindInput });
    await client.send(intent);
    await client.sendIntegration({ action: "map", input: { sourceItemId: "source-item-1", skillIds: ["skill-1"] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.loadIntegration();
    expect(client.getSnapshot().uncertain).toBe(true);
    await client.recover();
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/opening/exam-sprint/integration", "POST"], ["/api/opening/exam-sprint/integration", "GET"],
      ["/api/opening/exam-sprint/integration", "GET"], ["/api/opening/exam-sprint/integration", "POST"],
    ]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[3]![1]?.body);
    expect(keys).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toMatchObject({ uncertain: false, integration });
  });

  it("retains PATCH method and mapping input through unknown result recovery", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(new Response("invalid response"))
      .mockResolvedValueOnce(Response.json(integration)).mockResolvedValueOnce(Response.json(integration));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.sendIntegration({ action: "map", input: { sourceItemId: "source-item-1", skillIds: ["skill-1", "skill-2"] } });
    expect(client.getSnapshot().uncertain).toBe(true);
    await client.recover();
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["PATCH", "GET", "PATCH"]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[2]![1]?.body);
  });

  it("reuses the original image-review request when no review id was received", async () => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValueOnce(new Error("lost review receipt"))
      .mockResolvedValueOnce(Response.json(overview())).mockResolvedValueOnce(Response.json(review))
      .mockResolvedValueOnce(Response.json({ ...review, status: "unknown" }));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.sendIntegration({ action: "review", input: reviewInput });
    await client.recover();
    expect(fetcher.mock.calls[1]![0]).toBe("/api/opening/exam-sprint");
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[2]![1]?.body);
    expect(client.getSnapshot().review?.status).toBe("pending");
    await client.loadReview(review.id);
    expect(fetcher.mock.calls[3]![0]).toBe(`/api/opening/exam-sprint/reviews?id=${review.id}`);
    expect(fetcher.mock.calls[3]![1]?.method).toBe("GET");
    expect(client.getSnapshot().review?.status).toBe("unknown");
  });

  it("encodes teacher filters and never acknowledges malformed forecast writes", async () => {
    const forecast = { teacher: "A & B", papers: [], topics: [], status: "no_history", message: "无真卷" };
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(Response.json(forecast)).mockResolvedValueOnce(Response.json({ papers: [] }));
    const client = createExamSprintClient({ fetcher, keyFactory: () => key });
    await client.loadForecast(" A & B ");
    expect(fetcher.mock.calls[0]![0]).toBe("/api/opening/exam-sprint/forecast?teacher=A%20%26%20B");
    await client.sendIntegration({ action: "paper", input: { sourceId: reviewInput.referenceSourceId, sourceVersion: 2, teacher: "A & B", year: 2025, label: "期末", kind: "past_exam", skills: [{ skillId: "skill-1", points: 10 }] } });
    expect(client.getSnapshot()).toMatchObject({ uncertain: true, forecast });
  });

  it("preserves photo version and human verification fields when reading saved source work", async () => {
    const result = overview();
    result.state.sourceRecords = [{ id: "record-1", sourceId: "source-item-1", phase: "first", outcome: "partial", assistance: "hint", durationMinutes: 10, errorCause: "method", note: "核对中", recordedAt: "2026-10-17T12:00:00Z", answerText: "解题过程", workSourceId: reviewInput.workSourceId, workSourceVersion: 1, reviewId: review.id, referenceChecked: true }];
    const client = createExamSprintClient({ fetcher: vi.fn<Fetcher>().mockResolvedValueOnce(Response.json(result)) });
    await client.load();
    expect(client.getSnapshot().overview?.state.sourceRecords[0]).toEqual(result.state.sourceRecords[0]);
  });
});
