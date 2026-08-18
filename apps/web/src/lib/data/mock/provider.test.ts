import { describe, expect, it } from "vitest";
import type { StorageLike } from "./storage";
import { createMockProvider } from "./provider";
import { mockKey } from "./storage";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-02T08:00:00.000Z");

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function createProvider() {
  return createMockProvider({
    userId: USER_ID,
    now: NOW,
    delayMs: 0,
    storage: createMemoryStorage(),
    fetchDocuments: async () => [
      { id: "remote-1", title: "外部导数笔记", body: "导数的几何意义", tags: ["外部"] },
    ],
  });
}

describe("MockStudyDataProvider", () => {
  it("seeds status distribution and keeps plan overlays within the budget", async () => {
    const provider = createProvider();
    const statuses = await provider.listStatuses();
    expect(statuses.map((item) => item.status).sort()).toEqual([
      "stable",
      "stable",
      "untested",
      "untested",
      "untested",
      "untested",
      "untested",
      "usable",
      "usable",
      "usable",
      "weak",
      "weak",
    ]);

    const plan = await provider.getTodayPlan("2026-08-02");
    expect(plan.totalMinutes).toBeLessThanOrEqual(plan.budgetMinutes);
    const firstTask = plan.tasks[0];
    expect(firstTask).toBeDefined();
    if (!firstTask) return;

    await provider.toggleTaskLock("2026-08-02", firstTask.id);
    await provider.setTaskStatus("2026-08-02", firstTask.id, "done");
    const updated = await provider.getTodayPlan("2026-08-02");
    expect(updated.tasks[0]).toMatchObject({ id: firstTask.id, locked: true, status: "done" });
  });

  it("recovers from a malformed goals domain instead of crashing", async () => {
    const storage = createMemoryStorage();
    storage.setItem(mockKey(USER_ID, "goals"), "{}");
    const provider = createMockProvider({ userId: USER_ID, now: NOW, delayMs: 0, storage });

    await expect(provider.listGoals()).resolves.toHaveLength(1);
  });

  it("recovers from a wrong-shaped goals collection", async () => {
    const storage = createMemoryStorage();
    storage.setItem(mockKey(USER_ID, "goals"), JSON.stringify([{}]));
    const provider = createMockProvider({ userId: USER_ID, now: NOW, delayMs: 0, storage });

    await expect(provider.listGoals()).resolves.toHaveLength(1);
  });

  it("does not seed a valid empty goals collection", async () => {
    const storage = createMemoryStorage();
    storage.setItem(mockKey(USER_ID, "goals"), "[]");
    const provider = createMockProvider({ userId: USER_ID, now: NOW, delayMs: 0, storage });

    await expect(provider.listGoals()).resolves.toEqual([]);
    expect(storage.getItem(mockKey(USER_ID, "practiceItems"))).toBeNull();
  });

  it("rejects plan generation when every goal is archived", async () => {
    const provider = createProvider();
    const [goal] = await provider.listGoals();
    expect(goal).toBeDefined();
    if (!goal) return;

    await provider.archiveGoal(goal.id);
    await expect(provider.getTodayPlan("2026-08-02")).rejects.toThrow("请先创建一个学习目标");
  });

  it("prunes overlays for tasks omitted from a regenerated plan", async () => {
    const storage = createMemoryStorage();
    const provider = createMockProvider({ userId: USER_ID, now: NOW, delayMs: 0, storage });
    const date = "2026-08-02";
    const goal = (await provider.listGoals())[0];
    const initialPlan = await provider.getTodayPlan(date);
    const omittedTask = initialPlan.tasks.at(-1);
    expect(goal).toBeDefined();
    expect(omittedTask).toBeDefined();
    if (!goal || !omittedTask) return;

    await provider.setTaskStatus(date, omittedTask.id, "done");
    await provider.updateGoal(goal.id, { dailyMinutes: 5 });
    const regeneratedPlan = await provider.getTodayPlan(date);
    const snapshots = JSON.parse(storage.getItem(mockKey(USER_ID, "plans")) ?? "{}") as Record<
      string,
      { overlays: Record<string, unknown> }
    >;

    expect(regeneratedPlan.tasks.some((task) => task.id === omittedTask.id)).toBe(false);
    expect(snapshots[date]?.overlays).not.toHaveProperty(omittedTask.id);
  });

  it("prunes a locked task when it is omitted from the regenerated plan", async () => {
    const provider = createProvider();
    const date = "2026-08-02";
    const initialPlan = await provider.getTodayPlan(date);
    const lockedTask = initialPlan.tasks.at(-1);
    expect(lockedTask).toBeDefined();
    if (!lockedTask) return;

    await provider.toggleTaskLock(date, lockedTask.id);
    const goal = (await provider.listGoals())[0];
    expect(goal).toBeDefined();
    if (!goal) return;
    await provider.updateGoal(goal.id, { dailyMinutes: 5 });

    const regeneratedPlan = await provider.getTodayPlan(date);
    expect(regeneratedPlan.tasks.some((task) => task.id === lockedTask.id)).toBe(false);
  });

  it("does not carry a locked task from an archived goal into the next goal", async () => {
    const provider = createProvider();
    const initialGoal = (await provider.listGoals())[0];
    const initialPlan = await provider.getTodayPlan("2026-08-02");
    const lockedTask = initialPlan.tasks[0];
    expect(initialGoal).toBeDefined();
    expect(lockedTask).toBeDefined();
    if (!initialGoal || !lockedTask) return;

    await provider.toggleTaskLock("2026-08-02", lockedTask.id);
    await provider.archiveGoal(initialGoal.id);
    await provider.createGoal({
      title: "第二个学习目标",
      scenario: "custom",
      examDate: null,
      subjects: ["数学"],
      dailyMinutes: 45,
      courseId: null,
    });

    const nextPlan = await provider.getTodayPlan("2026-08-02");
    expect(nextPlan.tasks.find((task) => task.refId === lockedTask.refId)?.locked).not.toBe(true);
  });

  it("deduplicates attempts by idempotency key and recomputes status", async () => {
    const provider = createProvider();
    const item = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(item).not.toBeNull();
    if (!item) return;

    const input = {
      practiceItemId: item.id,
      answer: item.answer,
      durationMs: 42000,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-provider-001",
    } as const;
    const first = await provider.submitAttempt(input);
    const second = await provider.submitAttempt(input);
    expect(second).toEqual(first);
    expect(first.event.idempotencyKey).toBe(input.idempotencyKey);
    expect(first.status.syllabusPointId).toBe(item.syllabusPointId);
  });

  it("keeps a server-assigned attempt id when one is provided", async () => {
    const provider = createProvider();
    const item = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(item).not.toBeNull();
    if (!item) return;
    const eventId = "66666666-6666-4666-8666-666666666666";
    const result = await provider.submitAttempt({
      practiceItemId: item.id,
      answer: item.answer,
      durationMs: 1,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-server-id-001",
      eventId,
    });
    expect(result.event.id).toBe(eventId);
  });

  it("normalizes full-width answers and checkpoint ordering before recording correctness", async () => {
    const provider = createProvider();
    const choice = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(choice).not.toBeNull();
    if (!choice) return;

    const first = await provider.submitAttempt({
      practiceItemId: choice.id,
      answer: "　ａ ",
      durationMs: 1,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-full-width-001",
    });
    expect(first.event.correct).toBe(true);

    const checkpoint = await provider.createPracticeItem({
      kind: "checkpoint",
      stem: "步骤",
      answer: "0,2",
      options: ["第一步", "第二步", "第三步"],
    });
    const second = await provider.submitAttempt({
      practiceItemId: checkpoint.id,
      answer: " ２，０ ",
      durationMs: 1,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-checkpoint-order-001",
    });
    expect(second.event.correct).toBe(true);
  });

  it("grades due cards, supports silent turns, and creates a candidate on every second user turn", async () => {
    const provider = createProvider();
    const due = await provider.listDueCards();
    expect(due).toHaveLength(3);
    const nextState = await provider.gradeCard(due[0]?.card.id ?? "", "good");
    expect(nextState.reps).toBe(1);
    expect(nextState.lastGrade).toBe("good");

    const exploration = (await provider.listExplorations())[0];
    expect(exploration).toBeDefined();
    if (!exploration) return;
    const silent = await provider.sendExplorationMessage(exploration.id, "先只记录这个问题", "silent");
    expect(silent.aiTurn).toBeNull();
    expect(silent.candidate?.kind).toBe("note");
  });

  it("keeps candidate promotion status idempotent", async () => {
    const provider = createProvider();
    const exploration = (await provider.listExplorations())[0];
    expect(exploration).toBeDefined();
    if (!exploration) return;
    const candidate = (await provider.getExploration(exploration.id))?.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const promoted = await provider.setCandidateStatus(candidate.id, "promoted", "target-1");
    const repeated = await provider.setCandidateStatus(candidate.id, "promoted", "target-2");
    expect(repeated).toEqual(promoted);
  });

  it("uses the selected role template and rotates it by user turn count", async () => {
    const provider = createProvider();
    const exploration = (await provider.listExplorations())[0];
    expect(exploration).toBeDefined();
    if (!exploration) return;

    const first = await provider.sendExplorationMessage(exploration.id, "编辑这段关于熵的笔记", "editor");
    const second = await provider.sendExplorationMessage(exploration.id, "继续编辑这段关于熵的笔记", "editor");

    expect(first.aiTurn?.content).toContain("整理成更清晰的结构");
    expect(second.aiTurn?.content).toContain("压缩重复表达");
    expect(first.aiTurn?.content).toMatch(/（模拟回复）$/);
    expect(second.aiTurn?.content).toMatch(/（模拟回复）$/);
  });

  it("creates a due review card and a practice item on syllabus point 01", async () => {
    const provider = createProvider();
    const extended = provider as typeof provider & {
      createReviewCard(input: { front: string; back: string; tags: string[] }): Promise<{
        id: string;
        front: string;
        back: string;
      }>;
      createPracticeItem(input: { stem: string; answer: string }): Promise<{
        id: string;
        syllabusPointId: string;
        stem: string;
      }>;
    };

    const card = await extended.createReviewCard({
      front: "候选正面",
      back: "候选背面",
      tags: ["探索"],
    });
    expect(card).toMatchObject({ front: "候选正面", back: "候选背面" });
    expect((await provider.listDueCards(NOW)).some((item) => item.card.id === card.id)).toBe(true);

    const item = await extended.createPracticeItem({ stem: "候选题干", answer: "候选答案" });
    expect(item).toMatchObject({
      syllabusPointId: "11111111-1111-4111-8111-111111111101",
      stem: "候选题干",
    });
  });

  it("merges remote documents into ranked search and stores backlinks", async () => {
    const provider = createProvider();
    const hits = await provider.searchAll("导数");
    expect(hits.some((hit) => hit.type === "card")).toBe(true);
    expect(hits.some((hit) => hit.id === "remote-1")).toBe(true);

    await provider.indexDocumentLinks("doc-1", "源笔记", ["目标笔记", "目标笔记"]);
    expect(await provider.listBacklinks("目标笔记")).toEqual([
      expect.objectContaining({ sourceDocumentId: "doc-1", sourceTitle: "源笔记" }),
    ]);
  });

  it("includes user-managed document tags in search and deduplicates case variants", async () => {
    const provider = createProvider();
    await provider.setDocumentTags("remote-1", ["专题", " 专题 ", "ＴＯＰＩＣ", "topic"]);

    await expect(provider.getDocumentTags("remote-1")).resolves.toEqual(["专题", "TOPIC"]);
    const hits = await provider.searchAll(" ＴＯＰＩＣ ");
    expect(hits.find((hit) => hit.id === "remote-1")?.type).toBe("document");
  });

  it("feeds review grades on syllabus-bound cards into that point's status", async () => {
    const provider = createProvider();
    const untested = (await provider.listStatuses()).find((s) => s.status === "untested");
    expect(untested).toBeDefined();
    if (!untested) return;

    const card = await provider.createReviewCard({
      front: "测试卡正面",
      back: "测试卡背面",
      syllabusPointId: untested.syllabusPointId,
    });
    await provider.gradeCard(card.id, "good");
    await provider.gradeCard(card.id, "good");

    const after = (await provider.listStatuses()).find((s) => s.syllabusPointId === untested.syllabusPointId);
    expect(after?.status).toBe("usable");
  });

  it("applies a status correction override to the affected point", async () => {
    const provider = createProvider();
    const target = (await provider.listStatuses())[0];
    expect(target).toBeDefined();
    if (!target) return;

    await provider.recordStatusCorrection(target.syllabusPointId, "我觉得应该是稳固", "stable");

    const after = (await provider.listStatuses()).find((s) => s.syllabusPointId === target.syllabusPointId);
    expect(after?.status).toBe("stable");
    expect(after?.reasonCodes).toContain("user-correction");
  });

  it("uses an injected syllabus instead of the seed list", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      syllabus: [{ id: "99999999-9999-4999-8999-999999999999", title: "自定义考点" }],
    });

    const statuses = await provider.listStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.syllabusPointId).toBe("99999999-9999-4999-8999-999999999999");
    expect(statuses[0]?.status).toBe("untested");
  });

  it("combines daily budgets of multiple active goals", async () => {
    const provider = createProvider();
    const first = (await provider.listGoals())[0];
    expect(first).toBeDefined();
    if (!first) return;

    await provider.updateGoal(first.id, { dailyMinutes: 30 });
    await provider.createGoal({
      title: "第二个学习目标",
      scenario: "custom",
      examDate: null,
      subjects: ["数学"],
      dailyMinutes: 20,
      courseId: null,
    });

    const plan = await provider.getTodayPlan("2026-08-02");
    expect(plan.budgetMinutes).toBe(50);
    expect(plan.totalMinutes).toBeLessThanOrEqual(50);
  });

  it("skips practice tasks but keeps reviews when assessment is disabled", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      assessmentMode: "disabled",
    });

    const plan = await provider.getTodayPlan("2026-08-02");
    expect(plan.tasks.every((task) => task.kind !== "practice")).toBe(true);
    expect(plan.tasks.filter((task) => task.kind === "review").length).toBeGreaterThan(0);
  });

  it("marks every syllabus status untested when assessment is disabled", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      assessmentMode: "disabled",
    });

    const statuses = await provider.listStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((item) => item.status === "untested")).toBe(true);
    expect(statuses.every((item) => item.reasonCodes.includes("assessment-disabled"))).toBe(true);
  });
});
