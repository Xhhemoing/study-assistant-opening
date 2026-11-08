import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamPack, ExamSprintCommand, ExamSprintOverview } from "@aistudy/contracts";
import { createOpeningExamSprintRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "sprint-fixture", version: "1", title: "Fixture", description: "Reviewed test pack",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson", topicId: "limits", title: "Limits", summary: "Review", steps: ["Compare"], workedExample: "Worked example", pitfalls: [] }],
  questions: ["training-1", "training-2", "mock-a-1", "mock-b-1"].map((id, index) => ({
    id, topicId: "limits", skillId: "limit-rules", familyId: `family-${index}`, lessonId: "lesson",
    pool: index < 2 ? "training" : index === 2 ? "mock-a" : "mock-b", difficulty: index === 1 ? "transfer" : "foundation",
    prompt: `Question ${index}`, options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }],
    answer: "a", explanation: `secret-explanation-${index}`, hint: `secret-hint-${index}`, estimatedMinutes: 2,
  })),
  sourceItems: [{ id: "source-1", topicId: "limits", label: "Exercise 1", sourceTitle: "Worksheet", sourcePage: 1,
    kind: "exercise", suggestedDay: 1, skills: ["limit-rules"] }],
  weekPlan: [{ day: 1, minutes: 30, title: "Practice", tasks: ["Work the source exercise"] }], limitations: ["Fixture"],
};
const key = () => `sprint:${randomUUID()}`;
let fixture: OpeningFixture;
let repository: ReturnType<typeof createOpeningExamSprintRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  repository = createOpeningExamSprintRepository(fixture.sql, pack);
});
beforeEach(async () => { await fixture.sql`TRUNCATE opening_exam_sprints CASCADE`; });
afterAll(async () => { await fixture?.close(); });

function start(mode: "diagnostic" | "mock-a" = "diagnostic") {
  return repository.act(fixture.scope, { action: "start", mode, clientKey: key() });
}
function answer(view: ExamSprintOverview, clientKey = key()) {
  return repository.act(fixture.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: "a", confidence: 4, clientKey });
}
async function countRows() {
  const [row] = await fixture.sql`SELECT (SELECT count(*) FROM opening_exam_sprints) AS sprints,
    (SELECT count(*) FROM opening_exam_sprint_commands) AS commands`;
  return row;
}

describe("isolated exam sprint repository", () => {
  it("retains private part declarations through a real persisted snapshot without leaking sealed rules", async () => {
    const revised = structuredClone(pack), q = revised.questions.find(q => q.pool === "mock-a")!;
    q.partSnapshot = { packId: revised.id, packVersion: revised.version, questionId: q.id, familyId: q.familyId,
      questionIdentityRefId: randomUUID(), parts: [
        { partId: "left", identityRefId: randomUUID(), requirementKey: "requirement-left", evaluator: { kind: "choice-options-v1", correctOptionIds: ["b"] } },
        { partId: "right", identityRefId: randomUUID(), requirementKey: "requirement-right" },
      ] };
    const repo = createOpeningExamSprintRepository(fixture.sql, revised);
    const input = { action: "start" as const, mode: "mock-a" as const, clientKey: key() };
    const first = await repo.act(fixture.scope, input);
    await repo.act(fixture.scope, { action: "answer", attemptId: first.currentAttempt!.id, answer: "a", confidence: 4, clientKey: key() });
    const [saved] = await fixture.sql`SELECT pack_snapshot,state FROM opening_exam_sprints WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
    expect((saved!.pack_snapshot as ExamPack).questions.find(q => q.id === first.currentAttempt!.questionId)?.partSnapshot).toEqual(q.partSnapshot);
    expect((saved!.state as { attempts: Array<{ correct: boolean; resultMetadata?: unknown }> }).attempts[0]).toMatchObject({ correct: true });
    for (const view of [await repo.read(fixture.scope), await repo.export(fixture.scope), await repo.act(fixture.scope, input)]) {
      expect(view.attempts[0]!.correct).toBeNull();
      expect(JSON.stringify(view)).not.toMatch(/partSnapshot|correctOptionIds|questionIdentityRefId|resultMetadata/);
    }
  });

  it("rejects duplicate or foreign question revision part declarations at configuration admission", () => {
    const revised = structuredClone(pack), q = revised.questions[0]!;
    const part = { partId: "left", identityRefId: randomUUID(), requirementKey: "requirement-left" };
    q.partSnapshot = { packId: revised.id, packVersion: revised.version, questionId: q.id, familyId: q.familyId,
      questionIdentityRefId: randomUUID(), parts: [part, part] };
    expect(() => createOpeningExamSprintRepository(fixture.sql, revised)).toThrow("无法校验");
    q.partSnapshot.parts = [part]; q.partSnapshot.packVersion = "another-version";
    expect(() => createOpeningExamSprintRepository(fixture.sql, revised)).toThrow("无法校验");
  });

  it("reads and exports an initial overview without creating enrollment or exposing the answer bank", async () => {
    const view = await repository.read(fixture.scope);
    const exported = await repository.export(fixture.scope);
    expect(view.state.runs).toEqual([]);
    expect(view.pack).not.toHaveProperty("questions");
    expect(exported).toMatchObject({ format: "aistudy-exam-sprint-v1", commands: [], attempts: [] });
    expect(JSON.stringify(exported)).not.toContain("secret-");
    expect(await countRows()).toMatchObject({ sprints: "0", commands: "0" });
  });

  it("authorizes every operation using the workspace owner and keeps other workspaces isolated", async () => {
    await start();
    const forged = { workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.otherScope.ownerUserId };
    await expect(repository.read(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.export(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.act(forged, { action: "configure", clientKey: key(), examDate: null, dailyMinutes: 45 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repository.read(fixture.otherScope)).attempts).toEqual([]);
    expect(await countRows()).toMatchObject({ sprints: "1", commands: "1" });
  });

  it("serializes simultaneous first writes and replays an identical key without a second attempt or receipt", async () => {
    const input = { action: "start" as const, mode: "diagnostic" as const, clientKey: key() };
    const [first, retry] = await Promise.all([repository.act(fixture.scope, input), repository.act(fixture.scope, input)]);
    expect(first.currentAttempt!.id).toBe(retry.currentAttempt!.id);
    expect(first.attempts).toHaveLength(1);
    expect(await countRows()).toMatchObject({ sprints: "1", commands: "1" });
    await answer(first);
    const replayAfterAnswer = await repository.act(fixture.scope, input);
    expect(replayAfterAnswer.attempts[0]!.answeredAt).not.toBeNull();
    await expect(repository.act(fixture.scope, { ...input, mode: "mock-a" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await countRows()).toMatchObject({ sprints: "1", commands: "2" });
  });

  it("retains one competing answer and commits the state and its receipt together", async () => {
    const pending = await start(), attemptId = pending.currentAttempt!.id;
    const results = await Promise.allSettled([
      repository.act(fixture.scope, { action: "answer", attemptId, answer: "a", confidence: 4, clientKey: key() }),
      repository.act(fixture.scope, { action: "answer", attemptId, answer: "b", confidence: 2, clientKey: key() }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const exported = await repository.export(fixture.scope);
    expect(exported.commands).toHaveLength(2);
    const receipt = exported.commands.find(command => command.intent.action === "answer")!;
    expect((receipt.intent as Extract<ExamSprintCommand, { action: "answer" }>).answer).toBe(exported.attempts[0]!.answer);
    const committed = await countRows();
    await expect(repository.act(fixture.scope, { action: "help", attemptId: "nonexistent", kind: "hint", clientKey: key() }))
      .rejects.toBeDefined();
    expect(await countRows()).toEqual(committed);
  });

  it("does not create partial state when the first command fails validation or domain checks", async () => {
    await expect(repository.act(fixture.scope, { action: "answer", attemptId: "missing", answer: "a", confidence: 3, clientKey: key() }))
      .rejects.toBeDefined();
    await expect(repository.act(fixture.scope, { action: "configure", examDate: "2026-02-30", dailyMinutes: 40, clientKey: key() }))
      .rejects.toBeDefined();
    expect(await countRows()).toMatchObject({ sprints: "0", commands: "0" });
  });

  it("keeps a frozen pack across application content updates and rejects corrupted persisted snapshots", async () => {
    const pending = await start();
    const changedPack = structuredClone(pack);
    changedPack.version = "2";
    changedPack.questions.forEach(question => { question.answer = "b"; question.explanation = "changed-answer-key"; });
    const upgraded = createOpeningExamSprintRepository(fixture.sql, changedPack);
    expect((await upgraded.read(fixture.scope)).pack.version).toBe("1");
    const graded = await upgraded.act(fixture.scope, { action: "answer", attemptId: pending.currentAttempt!.id,
      answer: "a", confidence: 4, clientKey: key() });
    expect(graded.attempts[0]!.correct).toBe(true);
    expect(graded.attempts[0]!.feedback!.explanation).toContain("secret-explanation");
    await fixture.sql`UPDATE opening_exam_sprints SET state=jsonb_set(state,'{runs,0,questionIds}','["missing-question"]'::jsonb)
      WHERE workspace_id=${fixture.scope.workspaceId}`;
    await expect(upgraded.read(fixture.scope)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(upgraded.act(fixture.scope, { action: "configure", examDate: null, dailyMinutes: 60, clientKey: key() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await countRows()).toMatchObject({ sprints: "1", commands: "2" });
  });

  it("uses the same safe view for read, mutation, and export before a mock is handed in", async () => {
    let pending = await start("mock-a");
    const runId = pending.activeRun!.id;
    expect(pending.currentAttempt!.question).not.toHaveProperty("answer");
    expect(pending.currentAttempt!.feedback).toBeNull();
    pending = await answer(pending);
    for (const view of [pending, await repository.read(fixture.scope), await repository.export(fixture.scope)]) {
      expect(view.attempts[0]).toMatchObject({ correct: null, feedback: null, hint: null, independent: false });
      expect(view.state).not.toHaveProperty("attempts");
      expect(view.pack).not.toHaveProperty("questions");
      expect(JSON.stringify(view)).not.toContain("secret-");
    }
    await repository.act(fixture.scope, { action: "finish", runId, clientKey: key() });
    const exported = await repository.export(fixture.scope);
    expect(exported.attempts[0]!.correct).toBe(true);
    expect(exported.attempts[0]!.feedback).not.toBeNull();
    expect(exported.commands).toHaveLength(3);
    expect(JSON.stringify(exported)).not.toContain("secret-explanation-3");
  });

  it("records source self-reports exactly once without writing existing mastery or measurement tables", async () => {
    const existingRows = () => fixture.sql`SELECT
      (SELECT count(*) FROM opening_measurement_trials) AS measurement,
      (SELECT count(*) FROM opening_learning_observations) AS observations,
      (SELECT count(*) FROM opening_learning_sessions) AS sessions,
      (SELECT count(*) FROM opening_tasks) AS tasks`;
    const before = await existingRows();
    const input: ExamSprintCommand = { action: "source", clientKey: key(), sourceId: "source-1", phase: "first",
      outcome: "partial", assistance: "hint", durationMinutes: 8, errorCause: "conditions", note: "Missed condition" };
    await repository.act(fixture.scope, input);
    await repository.act(fixture.scope, input);
    const exported = await repository.export(fixture.scope);
    expect(exported.state.sourceRecords).toHaveLength(1);
    expect(exported.commands).toHaveLength(1);
    expect(exported.state.sourceRecords[0]).toMatchObject({ outcome: "partial", assistance: "hint", durationMinutes: 8 });
    expect(await existingRows()).toEqual(before);
  });
});
