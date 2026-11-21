import { describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { DAY_EXCEPTION_SNAPSHOT_KIND } from "@aistudy/contracts";
import { resolveLocalDayBounds, SRS_VERSION } from "@aistudy/domain";
import { listCardQueue } from "./cards-ops";
import { createOpeningDayAdjustmentRepository } from "./opening-day-adjustment";
import { assertOpeningLearningManagementDraft } from "./opening-learning-management-draft";
import { validateOpeningLocalReplan } from "./opening-local-replan-validation";
import { acceptOpeningPlan } from "./opening-plan-accept";
import {
  assertCardSessionStop,
  resolveCardSessionRecoveryAllowance,
  sumCardRecoveryMinutesForDay,
  writeLearningCardSession,
} from "./opening-long-term-card-session";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const COURSE_A = "33333333-3333-4333-8333-333333333333";
const SPRINT_ID = "44444444-4444-4444-8444-444444444444";
const PACK_SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const SCOPE = { workspaceId: WS, ownerUserId: OWNER };

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createMockSql(
  handler: (query: string, values: unknown[]) => unknown[] | Promise<unknown[]>,
): Sql {
  const fn = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    return Promise.resolve(handler(query, values));
  };
  const tx = Object.assign(fn, {
    json: (value: unknown) => value,
  });
  return Object.assign(fn, {
    json: (value: unknown) => value,
    begin: async (...args: unknown[]) => {
      const callback = args[args.length - 1] as (t: unknown) => Promise<unknown>;
      return callback(tx);
    },
  }) as unknown as Sql;
}

function buildExamPack(skillIds: readonly string[]) {
  return {
    id: "pack-recovery-v1",
    version: "1.0.0",
    title: "高等数学真卷包",
    description: "历史真卷题包",
    topics: [{ id: "topic-1", title: "微积分核心" }],
    lessons: [{
      id: "lesson-1",
      topicId: "topic-1",
      title: "极限与导数",
      summary: "核心考点",
      steps: ["审题"],
      workedExample: "示例",
      pitfalls: ["边界"],
    }],
    questions: skillIds.map((skillId, idx) => ({
      id: `q-${idx + 1}`,
      topicId: "topic-1",
      skillId,
      familyId: `fam-${idx + 1}`,
      lessonId: "lesson-1",
      pool: "training" as const,
      difficulty: "foundation" as const,
      prompt: `题目 ${idx + 1}`,
      options: [
        { id: "a", label: "选项 A" },
        { id: "b", label: "选项 B" },
      ],
      answer: "a",
      explanation: "解析",
      hint: "提示",
      estimatedMinutes: 5,
    })),
    sourceItems: [{
      id: "src-item-1",
      topicId: "topic-1",
      label: "真卷题 1",
      sourceTitle: "2025 真卷",
      sourcePage: 1,
      kind: "problem" as const,
      suggestedDay: 1,
      skills: [skillIds[0]!],
    }],
    weekPlan: [{ day: 1, minutes: 30, title: "第 1 天", tasks: ["练习"] }],
    limitations: [],
  };
}

function buildExamState() {
  return {
    version: 1 as const,
    startedAt: "2026-10-01T00:00:00.000Z",
    examDate: "2026-12-20",
    dailyMinutes: 60,
    runs: [],
    attempts: [],
    sourceRecords: [],
    lessonExposures: [],
  };
}

function band1CardRow(input: {
  id: string;
  now: Date;
  dueAt: string;
  courseId?: string | null;
  memberCourseIds?: string[];
  syllabusPointId?: string | null;
  skillLabel?: string | null;
  goalPriority?: number;
  delayedCheckCovered?: boolean;
}) {
  const lastReview = new Date(input.now.getTime() - 10 * 86_400_000).toISOString();
  return {
    id: input.id,
    owner_user_id: OWNER,
    front: `front-${input.id}`,
    back: `back-${input.id}`,
    source_document_id: null,
    syllabus_point_id: input.syllabusPointId ?? null,
    tags: ["review:concept"],
    course_id: input.courseId === undefined ? COURSE_A : input.courseId,
    skill_label: input.skillLabel ?? null,
    origin_observation_root_id: null,
    auto_paused: false,
    archived: false,
    content_version: 1,
    paused_until: null,
    maintain_until: null,
    exclude_from_assessment: false,
    created_at: "2026-10-01T00:00:00.000Z",
    srs_version: SRS_VERSION,
    fsrs_state: {
      stability: 1.5,
      difficulty: 5,
      elapsedDays: 1,
      scheduledDays: 2,
      learningSteps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      lastReview,
    },
    ease: 2.5,
    interval_days: 2,
    due_at: input.dueAt,
    reps: 2,
    lapses: 0,
    last_grade: "good",
    state_updated_at: lastReview,
    state_owner_user_id: OWNER,
    goal_priority: input.goalPriority ?? 5,
    member_course_ids: input.memberCourseIds ?? [],
    delayed_check_covered: input.delayedCheckCovered ?? false,
  };
}

it("rejects a client active clock beyond either server elapsed time or its approved cap", () => {
  const base = { budgetMinutes: 10, startedAt: "2026-11-01T09:00:00Z", now: new Date("2026-11-01T09:05:00Z") };
  expect(() => assertCardSessionStop({ ...base, elapsedSeconds: 400 })).toThrow("时间");
  expect(() => assertCardSessionStop({ ...base, now: new Date("2026-11-01T10:00:00Z"), elapsedSeconds: 601 })).toThrow("时长");
  expect(() => assertCardSessionStop({ ...base, elapsedSeconds: 180 })).not.toThrow();
});

describe("Round-7 P1-1: listCardQueue supplies historical past_exam meanPoints (syllabusWeight)", () => {
  it("ranks card #201 (12 historical past_exam points, latest dueAt) ahead of 200 Band-1 cards worth 1 point each and retains it inside the first 200", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const skillIds = Array.from({ length: 201 }, (_, i) => `skill-${i + 1}`);
    const nodeIds = Array.from({ length: 201 }, (_, i) => uuid("aaaaaaaa", i + 1));
    const cardRows = Array.from({ length: 201 }, (_, i) => {
      const idx = i + 1;
      const dueAt = new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 60_000).toISOString();
      return band1CardRow({
        id: uuid("bbbbbbbb", idx),
        now,
        dueAt,
        syllabusPointId: nodeIds[i],
        skillLabel: `skill-label-${idx}`,
        goalPriority: 5,
      });
    });

    const binding = {
      courseId: COURSE_A,
      milestoneId: null,
      packSourceId: PACK_SOURCE_ID,
      boundAt: "2026-10-05T00:00:00.000Z",
      skills: skillIds.map((skillId, i) => ({
        skillId,
        nodeId: nodeIds[i]!,
        requirementKey: `req-${i + 1}`,
      })),
      materials: [{
        sourceTitle: "真卷",
        sourceId: PACK_SOURCE_ID,
        sourceVersion: 1,
      }],
    };
    const pack = buildExamPack(skillIds);
    const sprintState = buildExamState();

    // Split 201 skills across 3 real past_exam papers (<= 100 skills/paper per examPaperInputSchema).
    const paperSlices: Array<[number, number]> = [[0, 70], [70, 140], [140, 201]];
    const paperRows = paperSlices.map(([start, end], sliceIdx) => ({
      id: uuid("cccccccc", sliceIdx + 1),
      sprint_id: SPRINT_ID,
      course_id: COURSE_A,
      source_id: uuid("dddddddd", sliceIdx + 1),
      source_version: 1,
      teacher: "王教授",
      year: 2023 + sliceIdx,
      label: `真卷 ${sliceIdx + 1}`,
      kind: "past_exam",
      skills: skillIds.slice(start, end).map((skillId) => ({
        skillId,
        points: skillId === "skill-201" ? 12 : 1,
      })),
      client_key: `exam-paper-key-${sliceIdx + 1}`,
      recorded_at: "2026-10-10T00:00:00.000Z",
      binding,
      pack_snapshot: pack,
      sprint_state: sprintState,
    }));

    const executedQueries: string[] = [];
    const sql = createMockSql((query) => {
      executedQueries.push(query);
      if (query.includes("FROM cards c")) return cardRows;
      if (query.includes("FROM opening_exam_papers p")) return paperRows;
      if (query.includes("FROM opening_course_knowledge g")) {
        return nodeIds.map((nodeId) => ({ course_id: COURSE_A, node_id: nodeId }));
      }
      if (query.includes("FROM course_requirements")) return [];
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });

    expect(queue).toHaveLength(200);
    expect(queue[0]?.card.id).toBe(uuid("bbbbbbbb", 201));
    expect(queue.some((entry) => entry.card.id === uuid("bbbbbbbb", 201))).toBe(true);
    expect(
      executedQueries.some((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q)),
    ).toBe(false);
  });

  it("matches syllabusPointId-null cards via active course_requirements and never cross-matches an explicit syllabusPointId via shared skillLabel", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const nodeS1 = uuid("aaaaaaaa", 1);
    const nodeS2 = uuid("aaaaaaaa", 2);
    const skillIds = ["skill-s1", "skill-s2"];

    const cardUnboundMatchingReq = band1CardRow({
      id: uuid("bbbbbbbb", 1),
      now,
      dueAt: "2026-11-15T00:00:00.000Z",
      courseId: null,
      memberCourseIds: [COURSE_A],
      syllabusPointId: null,
      skillLabel: "  极限  ",
      goalPriority: 5,
    });
    const cardExplicitS2SharedLabel = band1CardRow({
      id: uuid("bbbbbbbb", 2),
      now,
      dueAt: "2026-11-01T00:00:00.000Z",
      courseId: COURSE_A,
      syllabusPointId: nodeS2,
      skillLabel: "极限",
      goalPriority: 5,
    });
    const binding = {
      courseId: COURSE_A,
      milestoneId: null,
      packSourceId: PACK_SOURCE_ID,
      boundAt: "2026-10-05T00:00:00.000Z",
      skills: [
        { skillId: "skill-s1", nodeId: nodeS1, requirementKey: "req-limit-1" },
        { skillId: "skill-s2", nodeId: nodeS2, requirementKey: "req-limit-2" },
      ],
      materials: [{ sourceTitle: "真卷", sourceId: PACK_SOURCE_ID, sourceVersion: 1 }],
    };
    const sql = createMockSql((query) => {
      if (query.includes("FROM cards c")) return [cardExplicitS2SharedLabel, cardUnboundMatchingReq];
      if (query.includes("FROM opening_exam_papers p")) {
        return [{
          id: uuid("cccccccc", 1),
          sprint_id: SPRINT_ID,
          course_id: COURSE_A,
          source_id: uuid("dddddddd", 1),
          source_version: 1,
          teacher: "李教授",
          year: 2025,
          label: "2025 真卷",
          kind: "past_exam",
          skills: [
            { skillId: "skill-s1", points: 14 },
            { skillId: "skill-s2", points: 1 },
          ],
          client_key: "exam-paper-key-s1-s2",
          recorded_at: "2026-10-10T00:00:00.000Z",
          binding,
          pack_snapshot: buildExamPack(skillIds),
          sprint_state: buildExamState(),
        }];
      }
      if (query.includes("FROM opening_course_knowledge g")) {
        return [
          { course_id: COURSE_A, node_id: nodeS1 },
          { course_id: COURSE_A, node_id: nodeS2 },
        ];
      }
      if (query.includes("FROM course_requirements")) {
        return [{
          course_id: COURSE_A,
          requirement_key: "req-limit-1",
          title: "极限",
          knowledge_node_id: nodeS1,
        }];
      }
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });
    // Card 1 (syllabusPointId=null, membership-linked to COURSE_A) gets 14 pts via active course_requirements.
    // Card 2 (explicit syllabusPointId=nodeS2) gets 1 pt ONLY from nodeS2 and does NOT borrow nodeS1's 14 pts via "极限".
    expect(queue.map((entry) => entry.card.id)).toEqual([
      cardUnboundMatchingReq.id,
      cardExplicitS2SharedLabel.id,
    ]);
  });
});

describe("Round-7 P1-2 & P2-1: symmetrical 30% card-recovery cap in plan confirmation and cross-midnight block clipping", () => {
  const planningSettings = {
    weekOneMonday: "2026-09-07",
    periodTimes: {},
    dailyWindow: { start: "07:30", end: "22:30" },
    lunch: { start: "12:00", end: "12:45" },
    dinner: { start: "18:00", end: "18:45" },
    sleep: { start: "23:00", end: "07:00" },
    timeZone: "Asia/Shanghai",
  };

  it("P2-1: charges only clipped same-day overlap for a 20m due_at:null pending review_cards block crossing midnight (23:42-00:02)", async () => {
    const reviewTaskId = uuid("eeeeeeee", 1);
    // 2026-11-18 23:42 to 2026-11-19 00:02 Asia/Shanghai = 2026-11-18T15:42Z to 16:02Z:
    // overlaps 2026-11-18 by 18m (23:42-00:00) and 2026-11-19 (day) by 2m (00:00-00:02).
    const crossMidnightBlock = {
      taskId: reviewTaskId,
      start: "2026-11-18T15:42:00.000Z",
      end: "2026-11-18T16:02:00.000Z",
      reason: "planned",
    };
    const reviewTask = {
      id: reviewTaskId,
      origin: "planner",
      client_key: "planner:2026-11-18:review_cards:none:long-term",
      status: "pending",
      minutes: 20,
      due_at: null,
      updated_at: "2026-11-18T10:00:00.000Z",
    };

    const prevDayBounds = resolveLocalDayBounds("2026-11-18", "Asia/Shanghai");
    const dayBounds = resolveLocalDayBounds("2026-11-19", "Asia/Shanghai");

    expect(
      sumCardRecoveryMinutesForDay({
        localDate: "2026-11-18",
        timeZone: "Asia/Shanghai",
        bounds: prevDayBounds,
        activities: [],
        tasks: [reviewTask],
        blocks: [crossMidnightBlock],
      }),
    ).toBe(18);

    expect(
      sumCardRecoveryMinutesForDay({
        localDate: "2026-11-19",
        timeZone: "Asia/Shanghai",
        bounds: dayBounds,
        activities: [],
        tasks: [reviewTask],
        blocks: [crossMidnightBlock],
      }),
    ).toBe(2);

    // Due-today task still charges max(scheduledMinutes, taskMinutes).
    expect(
      sumCardRecoveryMinutesForDay({
        localDate: "2026-11-19",
        timeZone: "Asia/Shanghai",
        bounds: dayBounds,
        activities: [],
        tasks: [{ ...reviewTask, due_at: "2026-11-19T14:00:00.000Z" }],
        blocks: [crossMidnightBlock],
      }),
    ).toBe(20);

    // Runtime writeLearningCardSession on 2026-11-19 (60m executable day, 18m cap):
    // 2m clipped overlap leaves 16m remaining -> 17m rejected, 16m allowed.
    const cardId = uuid("ffffffff", 1);
    const inserted: Record<string, unknown>[] = [];
    const sql = createMockSql((query, values) => {
      if (query.includes("opening_workspace_history_revisions") || query.includes("SELECT id FROM workspaces WHERE")) {
        return [{ id: WS }];
      }
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 75, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("FROM opening_tasks")) return [reviewTask];
      if (query.includes("FROM opening_plan_state")) {
        return [{ day: "2026-11-18", accepted_blocks: [crossMidnightBlock] }];
      }
      if (query.includes("FROM opening_plan_drafts")) return [];
      if (query.includes("SELECT c.* FROM cards c")) {
        return [band1CardRow({ id: cardId, now: new Date("2026-11-19T12:00:00.000Z"), dueAt: "2026-11-19T00:00:00.000Z" })];
      }
      if (query.includes("INSERT INTO opening_teaching_activities")) {
        const [id, , , goal, checkpoint, , intent] = values;
        inserted.push({
          id,
          status: "active",
          path_version: 1,
          goal_json: goal,
          checkpoint_json: checkpoint,
          create_intent: intent,
        });
        return [];
      }
      if (query.includes("SELECT goal_json FROM opening_teaching_activities")) return inserted;
      if (query.includes("UPDATE opening_teaching_activities SET goal_json")) return [];
      if (query.includes("SELECT * FROM opening_teaching_activities WHERE id=")) return inserted;
      return [];
    });

    const now = new Date("2026-11-19T12:00:00.000Z"); // 20:00 Asia/Shanghai
    await expect(
      writeLearningCardSession(sql, SCOPE, {
        action: "start",
        cardIds: [cardId],
        goalIds: [],
        budgetMinutes: 17,
        clientKey: "cross-midnight-17m",
      }, now),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(inserted).toHaveLength(0);

    const allowed = await writeLearningCardSession(sql, SCOPE, {
      action: "start",
      cardIds: [cardId],
      goalIds: [],
      budgetMinutes: 16,
      clientKey: "cross-midnight-16m",
    }, now);
    expect(allowed.budgetMinutes).toBe(16);
    expect(inserted).toHaveLength(1);
  });

  it("P1-2: rejects confirming a 10m review_cards plan draft after an 18m card session on a 60m executable day (28m > 18m) and enforces cross-midnight next-day cap", async () => {
    const suggestedCardTaskId = uuid("12121212", 1);
    const existingCardTaskId = uuid("12121212", 2);
    const day = "2026-11-19";
    const now = new Date("2026-11-19T04:00:00.000Z"); // 12:00 Asia/Shanghai

    const buildTx = (options: {
      daySessionMinutes?: number;
      nextDaySessionMinutes?: number;
      existingTasks?: Record<string, unknown>[];
      dailyMinutes?: number;
      bufferMinutes?: number;
      zeroSecondPriorSession?: boolean;
    }) => createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: {
            dailyMinutes: options.dailyMinutes ?? 75,
            bufferMinutes: options.bufferMinutes ?? 15,
            revision: 1,
            updatedAt: "2026-11-19T00:00:00.000Z",
          },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) return [];
      if (query.includes("FROM opening_plan_state")) return [];
      if (query.includes("FROM opening_tasks")) return options.existingTasks ?? [];
      if (query.includes("SELECT a.id FROM opening_teaching_activities a")) return [];
      if (query.includes("FROM opening_teaching_activities")) {
        const activities: Record<string, unknown>[] = [];
        if (options.daySessionMinutes) {
          activities.push({
            id: uuid("90909090", 1),
            course_id: null,
            status: "active",
            created_at: "2026-11-19T02:00:00.000Z",
            updated_at: "2026-11-19T02:00:00.000Z",
            create_intent: { protocol: "card-review-session-v1" },
            checkpoint_json: { cardReviewSession: { elapsedSeconds: 0, stoppedAt: null } },
            goal_json: {
              cardReviewSession: { budgetMinutes: options.daySessionMinutes },
              learningBudget: { localDate: "2026-11-19", timeZone: "Asia/Shanghai", minutes: options.daySessionMinutes },
            },
          });
        }
        if (options.nextDaySessionMinutes) {
          activities.push({
            id: uuid("90909090", 2),
            course_id: null,
            status: "active",
            created_at: "2026-11-20T02:00:00.000Z",
            updated_at: "2026-11-20T02:00:00.000Z",
            create_intent: { protocol: "card-review-session-v1" },
            checkpoint_json: { cardReviewSession: { elapsedSeconds: 0, stoppedAt: null } },
            goal_json: {
              cardReviewSession: { budgetMinutes: options.nextDaySessionMinutes },
              learningBudget: { localDate: "2026-11-20", timeZone: "Asia/Shanghai", minutes: options.nextDaySessionMinutes },
            },
          });
        }
        if (options.zeroSecondPriorSession) {
          activities.push({
            id: uuid("90909090", 3),
            course_id: null,
            status: "paused",
            created_at: "2026-11-19T01:00:00.000Z",
            updated_at: "2026-11-19T01:00:00.000Z",
            create_intent: { protocol: "card-review-session-v1" },
            checkpoint_json: { cardReviewSession: { elapsedSeconds: 0, stoppedAt: "2026-11-19T01:00:00.000Z" } },
            goal_json: {
              cardReviewSession: { budgetMinutes: 10 },
              learningBudget: { localDate: "2026-11-19", timeZone: "Asia/Shanghai", minutes: 10 },
            },
          });
        }
        return activities;
      }
      return [];
    }) as unknown as TransactionSql;

    // 1. 18m active bounded card session + confirming 10m suggested review_cards block -> 28m > 18m -> CONFLICT!
    const suggested10Block = {
      taskId: suggestedCardTaskId,
      start: "2026-11-19T06:00:00.000Z",
      end: "2026-11-19T06:10:00.000Z",
      reason: "planned",
    };
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({ daySessionMinutes: 18 }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: suggestedCardTaskId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 10,
            courseId: null,
          }],
          blocks: [suggested10Block],
        },
        now,
        { acceptedBlocks: [suggested10Block] },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 2. 18m active bounded card session + confirming 10m existing review_cards task -> CONFLICT!
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({
          daySessionMinutes: 18,
          existingTasks: [{
            id: existingCardTaskId,
            origin: "planner",
            client_key: `planner:${day}:review_cards:none:long-term`,
            status: "pending",
            minutes: 10,
            due_at: null,
          }],
        }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [],
          blocks: [{
            taskId: existingCardTaskId,
            start: "2026-11-19T06:00:00.000Z",
            end: "2026-11-19T06:10:00.000Z",
            reason: "planned",
          }],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 3. 10m session + 8m review_cards block = 18m <= 18m -> allowed!
    const suggested8Block = {
      taskId: suggestedCardTaskId,
      start: "2026-11-19T06:00:00.000Z",
      end: "2026-11-19T06:08:00.000Z",
      reason: "planned",
    };
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({ daySessionMinutes: 10 }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: suggestedCardTaskId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 8,
            courseId: null,
          }],
          blocks: [suggested8Block],
        },
        now,
        { acceptedBlocks: [suggested8Block] },
      ),
    ).resolves.toBeUndefined();

    // 4. Cross-midnight 23:58-00:18 (20m) review_cards block: 2m on day (ok), 18m on nextDay + 5m existing = 23m > 18m -> CONFLICT!
    const crossMidnightSuggestedBlock = {
      taskId: suggestedCardTaskId,
      start: "2026-11-19T15:58:00.000Z",
      end: "2026-11-19T16:18:00.000Z",
      reason: "planned",
    };
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({ daySessionMinutes: 0, nextDaySessionMinutes: 5 }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: suggestedCardTaskId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 20,
            courseId: null,
          }],
          blocks: [crossMidnightSuggestedBlock],
        },
        now,
        { acceptedBlocks: [crossMidnightSuggestedBlock] },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 5. 30m executable day (strictCap = 9m) after a 0s stopped session today: 10m block rejected, 9m allowed.
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({ dailyMinutes: 30, bufferMinutes: 0, zeroSecondPriorSession: true }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: suggestedCardTaskId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 10,
            courseId: null,
          }],
          blocks: [suggested10Block],
        },
        now,
        { acceptedBlocks: [suggested10Block] },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const suggested9Block = {
      taskId: suggestedCardTaskId,
      start: "2026-11-19T06:00:00.000Z",
      end: "2026-11-19T06:09:00.000Z",
      reason: "planned",
    };
    await expect(
      assertOpeningLearningManagementDraft(
        buildTx({ dailyMinutes: 30, bufferMinutes: 0, zeroSecondPriorSession: true }),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: suggestedCardTaskId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 9,
            courseId: null,
          }],
          blocks: [suggested9Block],
        },
        now,
        { acceptedBlocks: [suggested9Block] },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("Round-7 P2-2: delayed_check_covered scopes requirement-keyed retests to matching syllabus_point_id", () => {
  it("covers S1 via course_requirements.knowledge_node_id without demoting sibling card S2 sharing (course_id, skill_label)", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const nodeS1 = uuid("aaaaaaaa", 1);
    const nodeS2 = uuid("aaaaaaaa", 2);

    // Relational fixture matching the exact SQL predicate in listCardQueue:
    // course_requirements maps req-s1 -> S1, req-s2 -> S2 (both titled "极限").
    // opening_retest_activities has an accepted retest ONLY for requirement_key = "req-s1".
    const courseRequirements = [
      { course_id: COURSE_A, requirement_key: "req-s1", title: "极限", knowledge_node_id: nodeS1, lifecycle: "active" },
      { course_id: COURSE_A, requirement_key: "req-s2", title: "极限", knowledge_node_id: nodeS2, lifecycle: "active" },
    ];
    const activeRetests = [
      { course_id: COURSE_A, skill_label: "极限", requirement_key: "req-s1", status: "accepted" },
    ];

    const evalDelayedCheckCovered = (card: { course_id: string | null; syllabus_point_id: string | null; skill_label: string | null }) =>
      activeRetests.some((r) => {
        if (r.course_id !== card.course_id) return false;
        if (card.syllabus_point_id !== null) {
          if (r.requirement_key === null) return false;
          return courseRequirements.some(
            (cr) =>
              cr.course_id === r.course_id
              && cr.requirement_key === r.requirement_key
              && cr.lifecycle === "active"
              && cr.knowledge_node_id === card.syllabus_point_id,
          );
        }
        if (!card.skill_label?.trim()) return false;
        if (r.skill_label.trim().toLowerCase() !== card.skill_label.trim().toLowerCase()) return false;
        if (r.requirement_key === null) return true;
        const matchedCr = courseRequirements.find(
          (cr) =>
            cr.course_id === r.course_id
            && cr.requirement_key === r.requirement_key
            && cr.lifecycle === "active"
            && cr.knowledge_node_id !== null,
        );
        if (!matchedCr) return true;
        const hasOtherNodeForLabel = courseRequirements.some(
          (cr2) =>
            cr2.course_id === r.course_id
            && cr2.lifecycle === "active"
            && cr2.title.trim().toLowerCase() === card.skill_label!.trim().toLowerCase()
            && cr2.knowledge_node_id !== matchedCr.knowledge_node_id,
        );
        return !hasOtherNodeForLabel;
      });

    const cardS1 = band1CardRow({
      id: uuid("bbbbbbbb", 1),
      now,
      dueAt: "2026-11-01T00:00:00.000Z",
      syllabusPointId: nodeS1,
      skillLabel: "极限",
      goalPriority: 5,
    });
    const cardS2 = band1CardRow({
      id: uuid("bbbbbbbb", 2),
      now,
      dueAt: "2026-11-18T00:00:00.000Z",
      syllabusPointId: nodeS2,
      skillLabel: "极限",
      goalPriority: 5,
    });
    const band4Filler = Array.from({ length: 199 }, (_, i) => ({
      ...band1CardRow({
        id: uuid("bbbbbbbb", i + 3),
        now,
        dueAt: "2026-11-02T00:00:00.000Z",
        syllabusPointId: uuid("aaaaaaaa", i + 10),
        skillLabel: `filler-${i}`,
        goalPriority: 5,
      }),
      fsrs_state: {
        stability: 30,
        difficulty: 5,
        elapsedDays: 1,
        scheduledDays: 30,
        learningSteps: 0,
        reps: 4,
        lapses: 0,
        state: 2,
        lastReview: new Date(now.getTime() - 86_400_000).toISOString(),
      },
    }));

    let capturedCardQuery = "";
    const sql = createMockSql((query) => {
      if (query.includes("FROM cards c")) {
        capturedCardQuery = query;
        return [
          { ...cardS1, delayed_check_covered: evalDelayedCheckCovered(cardS1) },
          { ...cardS2, delayed_check_covered: evalDelayedCheckCovered(cardS2) },
          ...band4Filler,
        ];
      }
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });

    // Verify SQL enforces syllabus_point_id -> course_requirements.knowledge_node_id scoping.
    expect(capturedCardQuery).toContain("c.syllabus_point_id IS NOT NULL");
    expect(capturedCardQuery).toContain("r.requirement_key IS NOT NULL");
    expect(capturedCardQuery).toContain("cr.knowledge_node_id = c.syllabus_point_id");
    expect(capturedCardQuery).toContain("c.syllabus_point_id IS NULL");

    // S2 stays uncovered in Band 1 at index 0 (inside the 200-card session); S1 is demoted to Band 5 and cut.
    expect(queue).toHaveLength(200);
    expect(queue[0]?.card.id).toBe(cardS2.id);
    expect(queue.some((entry) => entry.card.id === cardS1.id)).toBe(false);
  });
});

describe("Round-8 fixes: persisted-block card cap in acceptOpeningPlan, archived requirement guard, unkeyed retest ambiguity, and 10m floor copy", () => {
  const planningSettings = {
    weekOneMonday: "2026-09-07",
    periodTimes: {},
    dailyWindow: { start: "07:30", end: "22:30" },
    lunch: { start: "12:00", end: "12:45" },
    dinner: { start: "18:00", end: "18:45" },
    sleep: { start: "23:00", end: "07:00" },
    timeZone: "Asia/Shanghai",
  };

  it("P1-1: acceptOpeningPlan allows deselected review_cards suggestion (acceptSuggestedKeys: []) while rejecting selected review_cards exceeding 30% cap", async () => {
    const day = "2026-11-19";
    const now = new Date("2026-11-19T05:00:00.000Z"); // 13:00 Asia/Shanghai
    const draftId = uuid("13131313", 1);
    const ordinaryTaskId = uuid("13131313", 2);
    const cardSuggestionId = uuid("13131313", 3);
    const cardSuggestionKey = `planner:${day}:review_cards:none:long-term`;

    const ordinaryBlock = {
      taskId: ordinaryTaskId,
      start: "2026-11-19T06:00:00.000Z", // 14:00 Asia/Shanghai
      end: "2026-11-19T06:20:00.000Z",   // 14:20 Asia/Shanghai (20m)
      reason: "planned",
    };
    const cardSuggestionBlock = {
      taskId: cardSuggestionId,
      start: "2026-11-19T06:30:00.000Z", // 14:30 Asia/Shanghai
      end: "2026-11-19T06:40:00.000Z",   // 14:40 Asia/Shanghai (10m)
      reason: "planned",
    };
    const cardSuggestion = {
      id: cardSuggestionId,
      key: cardSuggestionKey,
      kind: "review_cards",
      title: "到期卡片复习（有界会话）",
      minutes: 10,
      courseId: null,
      skillLabel: null,
      reasonCode: "review_cards",
      reason: "有到期卡片需要复习。",
    };
    const draftRow = {
      id: draftId,
      workspace_id: WS,
      owner_user_id: OWNER,
      day,
      status: "draft",
      origin: "manual",
      version: 0,
      base_version: 0,
      strategy_version: "ordinary-v1",
      hard_blocks_fingerprint: "",
      blocks: [ordinaryBlock, cardSuggestionBlock],
      suggested_tasks: [cardSuggestion],
      unscheduled_task_ids: [],
      input_snapshot: {
        tasks: [{
          id: ordinaryTaskId,
          version: 1,
          title: "高数练习",
          minutes: 20,
          dueAt: null,
          priority: 2,
          status: "pending",
        }],
      },
      reasons: {},
      propose_client_key: "ordinary-propose-1",
    };

    const buildAcceptSql = () => {
      let savedAcceptedBlocks: unknown = null;
      let insertedTaskCount = 0;
      const sql = createMockSql((query, values) => {
        if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
        if (query.includes("SELECT id FROM workspaces WHERE")) return [{ id: WS }];
        if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
          return [{
            learning_management: { dailyMinutes: 75, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
            planning_settings: planningSettings,
          }];
        }
        if (query.includes("SELECT planning_settings FROM workspace_preferences")) {
          return [{ planning_settings: planningSettings }];
        }
        if (query.includes("SELECT day FROM opening_plan_drafts")) return [{ day }];
        if (query.includes("SELECT * FROM opening_plan_drafts")) return [draftRow];
        if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) return [];
        if (query.includes("INSERT INTO opening_plan_state")) return [];
        if (query.includes("SELECT accepted_version, accepted_blocks, hard_blocks_fingerprint FROM opening_plan_state")) {
          return [{ accepted_version: 0, accepted_blocks: [], hard_blocks_fingerprint: "" }];
        }
        if (query.includes("SELECT day, accepted_blocks FROM opening_plan_state")) return [];
        if (query.includes("FROM opening_plan_acceptances")) return [];
        if (query.includes("SELECT a.id FROM opening_teaching_activities a")) return [];
        if (query.includes("FROM opening_teaching_activities")) {
          return [{
            id: uuid("91919191", 1),
            course_id: null,
            status: "active",
            created_at: "2026-11-19T02:00:00.000Z",
            updated_at: "2026-11-19T02:00:00.000Z",
            create_intent: { protocol: "card-review-session-v1" },
            checkpoint_json: { cardReviewSession: { elapsedSeconds: 0, stoppedAt: null } },
            goal_json: {
              cardReviewSession: { budgetMinutes: 18 },
              learningBudget: { localDate: day, timeZone: "Asia/Shanghai", minutes: 18 },
            },
          }];
        }
        if (query.includes("SELECT DISTINCT course_id FROM opening_tasks")) return [];
        if (query.includes("FROM opening_tasks")) {
          return [{
            id: ordinaryTaskId,
            workspace_id: WS,
            owner_user_id: OWNER,
            title: "高数练习",
            minutes: 20,
            due_at: null,
            not_before: null,
            priority: 2,
            status: "pending",
            version: 1,
            origin: "manual",
            client_key: null,
            retest_id: null,
            candidate_id: null,
            candidate_reference_id: null,
            scheduled_start_at: null,
            recommended_at: null,
            not_before_at: null,
            snoozed_until: null,
            learning_protocol: null,
          }];
        }
        if (query.includes("FROM opening_timetable_sessions") || query.includes("FROM opening_hard_blocks")) return [];
        if (query.includes("FROM opening_suggestion_feedback")) return [];
        if (query.includes("INSERT INTO opening_tasks")) {
          insertedTaskCount += 1;
          return [{ id: cardSuggestionId, version: 1 }];
        }
        if (query.includes("UPDATE opening_plan_state SET accepted_version=")) {
          savedAcceptedBlocks = values[1];
          return [];
        }
        if (query.includes("UPDATE opening_plan_drafts SET status='accepted'")) {
          return [{ ...draftRow, status: "accepted", version: 1, blocks: savedAcceptedBlocks }];
        }
        if (query.includes("INSERT INTO opening_plan_acceptances")) return [];
        return [];
      });
      return {
        sql,
        getSavedBlocks: () => savedAcceptedBlocks,
        getInsertedTaskCount: () => insertedTaskCount,
      };
    };

    // 1. Deselecting the 10m review_cards suggestion (`acceptSuggestedKeys: []`) succeeds and saves the 20m ordinary task!
    const deselected = buildAcceptSql();
    const accepted = await acceptOpeningPlan(
      deselected.sql,
      SCOPE,
      {
        draftId,
        expectedBaseVersion: 0,
        clientKey: "accept-ordinary-only-key-1",
        acceptSuggestedKeys: [],
      },
      now,
    );
    expect(accepted.status).toBe("accepted");
    expect(deselected.getSavedBlocks()).toEqual([ordinaryBlock]);
    expect(deselected.getInsertedTaskCount()).toBe(0);

    // 2. Selecting the 10m review_cards suggestion (`18m + 10m = 28m > 18m`) rejects with CONFLICT and zero writes!
    const selected = buildAcceptSql();
    await expect(
      acceptOpeningPlan(
        selected.sql,
        SCOPE,
        {
          draftId,
          expectedBaseVersion: 0,
          clientKey: "accept-with-cards-key-1",
          acceptSuggestedKeys: [cardSuggestionKey],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(selected.getSavedBlocks()).toBeNull();
    expect(selected.getInsertedTaskCount()).toBe(0);

    // 3. Omitting `acceptSuggestedKeys` (selects all suggestions) also rejects with CONFLICT and zero writes!
    const defaultSelect = buildAcceptSql();
    await expect(
      acceptOpeningPlan(
        defaultSelect.sql,
        SCOPE,
        {
          draftId,
          expectedBaseVersion: 0,
          clientKey: "accept-default-all-key-1",
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(defaultSelect.getSavedBlocks()).toBeNull();
    expect(defaultSelect.getInsertedTaskCount()).toBe(0);
  });

  it("P2-1: listCardQueue does not match an archived requirementKey directly on binding.skills when card.syllabusPointId is null", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const nodeArchived = uuid("aaaaaaaa", 11);
    const nodeActive = uuid("aaaaaaaa", 12);
    const skillIds = ["skill-archived", "skill-active"];

    const cardWithArchivedReqKey = band1CardRow({
      id: uuid("bbbbbbbb", 11),
      now,
      dueAt: "2026-11-01T00:00:00.000Z", // earlier dueAt
      courseId: COURSE_A,
      syllabusPointId: null,
      skillLabel: "req-archived-1", // matches archived requirement_key verbatim!
      goalPriority: 5,
    });
    const cardWithActiveReq = band1CardRow({
      id: uuid("bbbbbbbb", 12),
      now,
      dueAt: "2026-11-18T00:00:00.000Z", // later dueAt
      courseId: COURSE_A,
      syllabusPointId: null,
      skillLabel: "活跃考点",
      goalPriority: 5,
    });

    const binding = {
      courseId: COURSE_A,
      milestoneId: null,
      packSourceId: PACK_SOURCE_ID,
      boundAt: "2026-10-05T00:00:00.000Z",
      skills: [
        { skillId: "skill-archived", nodeId: nodeArchived, requirementKey: "req-archived-1" },
        { skillId: "skill-active", nodeId: nodeActive, requirementKey: "req-active-2" },
      ],
      materials: [{ sourceTitle: "真卷", sourceId: PACK_SOURCE_ID, sourceVersion: 1 }],
    };

    const sql = createMockSql((query) => {
      if (query.includes("FROM cards c")) return [cardWithArchivedReqKey, cardWithActiveReq];
      if (query.includes("FROM opening_exam_papers p")) {
        return [{
          id: uuid("cccccccc", 11),
          sprint_id: SPRINT_ID,
          course_id: COURSE_A,
          source_id: uuid("dddddddd", 11),
          source_version: 1,
          teacher: "张教授",
          year: 2025,
          label: "2025 真卷",
          kind: "past_exam",
          skills: [
            { skillId: "skill-archived", points: 15 },
            { skillId: "skill-active", points: 8 },
          ],
          client_key: "exam-paper-archived-guard",
          recorded_at: "2026-10-10T00:00:00.000Z",
          binding,
          pack_snapshot: buildExamPack(skillIds),
          sprint_state: buildExamState(),
        }];
      }
      if (query.includes("FROM opening_course_knowledge g")) {
        // Both nodes remain supported, yet req-archived-1 is archived in course_requirements.
        return [
          { course_id: COURSE_A, node_id: nodeArchived },
          { course_id: COURSE_A, node_id: nodeActive },
        ];
      }
      if (query.includes("FROM course_requirements")) {
        return [
          { course_id: COURSE_A, requirement_key: "req-archived-1", title: "旧考点", knowledge_node_id: nodeArchived, lifecycle: "archived" },
          { course_id: COURSE_A, requirement_key: "req-active-2", title: "活跃考点", knowledge_node_id: nodeActive, lifecycle: "active" },
        ];
      }
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });

    // Card with archived requirementKey keeps fallback goalPriority (5) instead of inheriting 15 pts,
    // so the active requirement card (8 pts) ranks ahead of it!
    expect(queue.map((entry) => entry.card.id)).toEqual([
      cardWithActiveReq.id,
      cardWithArchivedReqKey.id,
    ]);
  });

  it("P2-2: applies duplicate-active-requirement-title multi-node ambiguity guard to unkeyed retests (requirement_key IS NULL)", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const nodeS1 = uuid("aaaaaaaa", 21);
    const nodeS2 = uuid("aaaaaaaa", 22);

    const courseRequirements = [
      { course_id: COURSE_A, requirement_key: "req-lim-1", title: "极限", knowledge_node_id: nodeS1, lifecycle: "active" },
      { course_id: COURSE_A, requirement_key: "req-lim-2", title: "极限", knowledge_node_id: nodeS2, lifecycle: "active" },
    ];
    const unkeyedRetests = [
      { course_id: COURSE_A, skill_label: "极限", requirement_key: null as string | null, status: "accepted" },
    ];

    const evalDelayedCheckCovered = (
      card: { course_id: string | null; syllabus_point_id: string | null; skill_label: string | null },
      reqs: typeof courseRequirements,
    ) =>
      unkeyedRetests.some((r) => {
        if (r.course_id !== card.course_id) return false;
        if (card.syllabus_point_id !== null) return false;
        const label = card.skill_label?.trim().toLowerCase() ?? "";
        if (!label || r.skill_label.trim().toLowerCase() !== label) return false;
        const matchingNodes = new Set(
          reqs
            .filter(
              (cr) =>
                cr.course_id === r.course_id
                && cr.lifecycle === "active"
                && cr.knowledge_node_id !== null
                && (cr.title.trim().toLowerCase() === label || cr.requirement_key.trim().toLowerCase() === label),
            )
            .map((cr) => cr.knowledge_node_id!),
        );
        return matchingNodes.size < 2;
      });

    const legacyCard = band1CardRow({
      id: uuid("bbbbbbbb", 21),
      now,
      dueAt: "2026-11-18T00:00:00.000Z",
      syllabusPointId: null,
      skillLabel: "极限",
      goalPriority: 5,
    });
    const band4Filler = Array.from({ length: 200 }, (_, i) => ({
      ...band1CardRow({
        id: uuid("bbbbbbbb", i + 22),
        now,
        dueAt: "2026-11-01T00:00:00.000Z",
        syllabusPointId: uuid("aaaaaaaa", i + 100),
        skillLabel: `filler-${i}`,
        goalPriority: 5,
      }),
      fsrs_state: {
        stability: 30,
        difficulty: 5,
        elapsedDays: 1,
        scheduledDays: 30,
        learningSteps: 0,
        reps: 4,
        lapses: 0,
        state: 2,
        lastReview: new Date(now.getTime() - 86_400_000).toISOString(),
      },
    }));

    let capturedCardQuery = "";
    const sql = createMockSql((query) => {
      if (query.includes("FROM cards c")) {
        capturedCardQuery = query;
        return [
          { ...legacyCard, delayed_check_covered: evalDelayedCheckCovered(legacyCard, courseRequirements) },
          ...band4Filler,
        ];
      }
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });

    // SQL must guard label-only matches against >= 2 distinct active knowledge_node_ids regardless of r.requirement_key.
    expect(capturedCardQuery).toContain("FROM course_requirements cr1");
    expect(capturedCardQuery).toContain("JOIN course_requirements cr2");
    expect(capturedCardQuery).toContain("cr1.knowledge_node_id <> cr2.knowledge_node_id");
    expect(capturedCardQuery.indexOf("cr1.knowledge_node_id <> cr2.knowledge_node_id")).toBeLessThan(
      capturedCardQuery.indexOf("r.requirement_key IS NULL"),
    );

    // Legacy card stays uncovered in Band 1 at index 0 (not demoted to Band 5 behind 200 Band-4 cards).
    expect(evalDelayedCheckCovered(legacyCard, courseRequirements)).toBe(false);
    expect(evalDelayedCheckCovered(legacyCard, [courseRequirements[0]!])).toBe(true);
    expect(queue).toHaveLength(200);
    expect(queue[0]?.card.id).toBe(legacyCard.id);
  });

  it("P2-3: reports the 10-minute single-session maintenance floor explicitly rather than misstating 10m as 30% on a 30m executable day", async () => {
    const decision = resolveCardSessionRecoveryAllowance({
      dailyExecutableMinutes: 30,
      freeUnreservedMinutes: 30,
      usedOrReservedCardSessionMinutes: 0,
      isBacklogRecovery: false,
      hasPriorCardSessionToday: false,
    });
    expect(decision).toEqual({
      allowanceMinutes: 10,
      strictCapMinutes: 9,
      effectiveCapMinutes: 10,
      maintenanceFloorApplied: true,
    });

    const cardId = uuid("ffffffff", 31);
    const now = new Date("2026-11-19T12:00:00.000Z");
    const sql = createMockSql((query) => {
      if (query.includes("opening_workspace_history_revisions") || query.includes("SELECT id FROM workspaces WHERE")) {
        return [{ id: WS }];
      }
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 30, bufferMinutes: 0, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("FROM cards c")) {
        return [band1CardRow({ id: cardId, now, dueAt: "2026-11-19T00:00:00.000Z" })];
      }
      return [];
    });

    let caughtMessage = "";
    try {
      await writeLearningCardSession(sql, SCOPE, {
        action: "start",
        cardIds: [cardId],
        goalIds: [],
        budgetMinutes: 11,
        clientKey: "maintenance-floor-copy-11m",
      }, now);
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }
    expect(caughtMessage).toContain("30%");
    expect(caughtMessage).toContain("9 分钟");
    expect(caughtMessage).toContain("单次最低 10 分钟维护额度");
    expect(caughtMessage).toContain("10 分钟");
    expect(caughtMessage).not.toContain("可用上限为 10 分钟（不超过每日可执行学习时长的 30%）");
  });
});

describe("Round-9 fixes: standalone draft/replan 30% card cap, intraday post-adjustment card cap, and archived binding pre-filter", () => {
  const planningSettings = {
    weekOneMonday: "2026-09-07",
    periodTimes: {},
    dailyWindow: { start: "07:30", end: "22:30" },
    lunch: { start: "12:00", end: "12:45" },
    dinner: { start: "18:00", end: "18:45" },
    sleep: { start: "23:00", end: "07:00" },
    timeZone: "Asia/Shanghai",
  };

  it("P1-1: standalone assertOpeningLearningManagementDraft (no options) and standalone validateOpeningLocalReplan both reject over-cap card recovery", async () => {
    const day = "2026-11-19";
    const now = new Date("2026-11-19T05:00:00.000Z"); // 13:00 Asia/Shanghai
    const cardSuggestionId = uuid("14141414", 1);
    const cardSuggestionBlock = {
      taskId: cardSuggestionId,
      start: "2026-11-19T06:00:00.000Z", // 14:00 Asia/Shanghai
      end: "2026-11-19T06:10:00.000Z",   // 14:10 Asia/Shanghai (10m)
      reason: "planned",
    };

    const buildStandaloneTx = () => createMockSql((query) => {
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        return [{
          learning_management: { dailyMinutes: 75, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("SELECT planning_settings FROM workspace_preferences")) {
        return [{ planning_settings: planningSettings }];
      }
      if (query.includes("SELECT a.id FROM opening_teaching_activities a")) return [];
      if (query.includes("FROM opening_teaching_activities")) {
        return [{
          id: uuid("92929292", 1),
          course_id: null,
          status: "active",
          created_at: "2026-11-19T02:00:00.000Z",
          updated_at: "2026-11-19T02:00:00.000Z",
          create_intent: { protocol: "card-review-session-v1" },
          checkpoint_json: { cardReviewSession: { elapsedSeconds: 0, stoppedAt: null } },
          goal_json: {
            cardReviewSession: { budgetMinutes: 18 },
            learningBudget: { localDate: day, timeZone: "Asia/Shanghai", minutes: 18 },
          },
        }];
      }
      return [];
    }) as unknown as TransactionSql;

    // 1. Standalone assertOpeningLearningManagementDraft WITHOUT options.acceptedBlocks rejects!
    await expect(
      assertOpeningLearningManagementDraft(
        buildStandaloneTx(),
        SCOPE,
        {
          day,
          strategy_version: null,
          input_snapshot: {},
          suggested_tasks: [{
            id: cardSuggestionId,
            key: `planner:${day}:review_cards:none:long-term`,
            kind: "review_cards",
            minutes: 10,
            courseId: null,
          }],
          blocks: [cardSuggestionBlock],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 2. Standalone validateOpeningLocalReplan (no prior assertOpeningLearningManagementDraft) rejects!
    await expect(
      validateOpeningLocalReplan(
        buildStandaloneTx(),
        SCOPE,
        {
          day,
          state: { accepted_version: 0, accepted_blocks: [] },
          draft: {
            day,
            origin: "manual",
            strategy_version: "local-replan-v1",
            suggested_tasks: [{
              id: cardSuggestionId,
              key: `planner:${day}:review_cards:none:long-term`,
              kind: "review_cards",
              minutes: 10,
              courseId: null,
            }],
            input_snapshot: {
              tasks: [{
                id: cardSuggestionId,
                version: 1,
                title: "到期卡片复习（有界会话）",
                minutes: 10,
                dueAt: null,
                priority: 2,
                status: "pending",
              }],
              localReplan: {
                baseAcceptedVersion: 0,
                baselineBlocks: [],
                fixedBlocks: [],
                releasedTaskVersions: [],
                proposedAt: "2026-11-19T04:55:00.000Z",
                preserveAll: true,
              },
            },
          },
          blocks: [cardSuggestionBlock],
          now,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("P1-2: intraday adjustment allows replacing a 10m review_cards slot with a non-overlapping 10m slot on a 40m day (12m cap) and rejects keeping both (20m > 12m)", async () => {
    const day = "2026-11-19";
    const now = new Date("2026-11-19T10:55:00.000Z"); // 18:55 Asia/Shanghai
    const cardTask1 = uuid("15151515", 1);
    const cardTask2 = uuid("15151515", 2);
    const excId = uuid("15151515", 9);

    const existingBlockC1 = {
      taskId: cardTask1,
      start: "2026-11-19T11:00:00.000Z", // 19:00 Asia/Shanghai
      end: "2026-11-19T11:10:00.000Z",   // 19:10 Asia/Shanghai (10m)
      reason: "planned",
    };
    const newBlockC2 = {
      taskId: cardTask2,
      start: "2026-11-19T11:20:00.000Z", // 19:20 Asia/Shanghai
      end: "2026-11-19T11:30:00.000Z",   // 19:30 Asia/Shanghai (10m)
      reason: "planned",
    };

    const cardTasks = [
      {
        id: cardTask1,
        workspace_id: WS,
        owner_user_id: OWNER,
        title: "到期卡片复习 1",
        minutes: 10,
        status: "pending",
        version: 1,
        priority: 2,
        due_at: null,
        not_before: null,
        course_id: null,
        origin: "planner",
        client_key: `planner:${day}:review_cards:c1:long-term`,
        candidate_id: null,
        retest_id: null,
        candidate_reference_id: null,
        scheduled_start_at: null,
        recommended_at: null,
        not_before_at: null,
        snoozed_until: null,
        learning_protocol: null,
      },
      {
        id: cardTask2,
        workspace_id: WS,
        owner_user_id: OWNER,
        title: "到期卡片复习 2",
        minutes: 10,
        status: "pending",
        version: 1,
        priority: 2,
        due_at: null,
        not_before: null,
        course_id: null,
        origin: "planner",
        client_key: `planner:${day}:review_cards:c2:long-term`,
        candidate_id: null,
        retest_id: null,
        candidate_reference_id: null,
        scheduled_start_at: null,
        recommended_at: null,
        not_before_at: null,
        snoozed_until: null,
        learning_protocol: null,
      },
    ];

    const buildDayAdjustmentSql = () => createMockSql((query, values) => {
      if (query.includes("pg_advisory_xact_lock") || query.includes("opening_workspace_history_revisions")) return [];
      if (query.includes("FROM workspaces w LEFT JOIN workspace_preferences")) {
        // 55 - 15 = 40m executable day -> strict 30% card cap = 12m.
        return [{
          learning_management: { dailyMinutes: 55, bufferMinutes: 15, revision: 1, updatedAt: "2026-11-19T00:00:00.000Z" },
          planning_settings: planningSettings,
        }];
      }
      if (query.includes("FROM workspaces")) return [{ id: WS }];
      if (query.includes("FROM workspace_preferences")) return [{ planning_settings: planningSettings }];
      if (query.includes("FROM opening_plan_drafts") && query.includes("strategy_version")) {
        if (values[2] !== day) return [];
        return [{
          id: excId,
          version: 1,
          input_snapshot: {
            dayException: {
              kind: DAY_EXCEPTION_SNAPSHOT_KIND,
              clientKey: "12121212-1212-4121-8121-121212121212",
              localDate: day,
              timeZone: "Asia/Shanghai",
              effectiveAt: "2026-11-19T10:55:00.000Z",
              remainingMinutes: 25,
              expectedExceptionRevision: 0,
              revision: 1,
            },
          },
        }];
      }
      if (query.includes("FROM opening_plan_state")) {
        return [{ day, accepted_version: 1, accepted_blocks: [existingBlockC1], hard_blocks_fingerprint: "" }];
      }
      if (query.includes("SELECT DISTINCT course_id")) return [];
      if (query.includes("FROM opening_tasks")) return cardTasks;
      return [];
    });

    // 1. Replacing C1 (10m) with non-overlapping C2 (10m) -> net 10m <= 12m -> SUCCEEDS!
    const replaceRepo = createOpeningDayAdjustmentRepository(buildDayAdjustmentSql(), { clock: () => now });
    const receipt = await replaceRepo.confirm(SCOPE, {
      clientKey: "day-adjust:replace-card-10m",
      sourceDate: day,
      expectedTimeZone: "Asia/Shanghai",
      expectedExceptionRevision: 1,
      expectedBudgetRevision: 1,
      expectedSourceAcceptedVersion: 1,
      expectedTaskRevisions: [
        { taskId: cardTask1, version: 1 },
        { taskId: cardTask2, version: 1 },
      ],
      expectedRetestRevisions: [],
      sourceActions: {
        keptBlocks: [],
        removedBlocks: [existingBlockC1],
        addedBlocks: [newBlockC2],
      },
      targetActions: null,
    });
    expect(receipt.replayed).toBe(false);
    expect(receipt.sourceBlocks).toEqual([newBlockC2]);

    // 2. Keeping C1 (10m) and adding C2 (10m) -> 20m > 12m -> REJECTS with CONFLICT!
    const keepBothRepo = createOpeningDayAdjustmentRepository(buildDayAdjustmentSql(), { clock: () => now });
    await expect(
      keepBothRepo.confirm(SCOPE, {
        clientKey: "day-adjust:add-second-card-10m",
        sourceDate: day,
        expectedTimeZone: "Asia/Shanghai",
        expectedExceptionRevision: 1,
        expectedBudgetRevision: 1,
        expectedSourceAcceptedVersion: 1,
        expectedTaskRevisions: [
          { taskId: cardTask1, version: 1 },
          { taskId: cardTask2, version: 1 },
        ],
        expectedRetestRevisions: [],
        sourceActions: {
          keptBlocks: [existingBlockC1],
          removedBlocks: [],
          addedBlocks: [newBlockC2],
        },
        targetActions: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("P2-1: excludes archived requirement bindings before nodeId or key matching when active and archived requirements share knowledge_node_id", async () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const sharedNode = uuid("aaaaaaaa", 41);
    const otherNode = uuid("aaaaaaaa", 42);
    const skillIds = ["skill-archived-shared-node", "skill-active-shared-node", "skill-other"];

    const labelCardOnSharedNode = band1CardRow({
      id: uuid("bbbbbbbb", 41),
      now,
      dueAt: "2026-11-01T00:00:00.000Z", // earlier dueAt
      courseId: COURSE_A,
      syllabusPointId: null,
      skillLabel: "极限",
      goalPriority: 5,
    });
    const labelCardOnOtherNode = band1CardRow({
      id: uuid("bbbbbbbb", 42),
      now,
      dueAt: "2026-11-18T00:00:00.000Z", // later dueAt
      courseId: COURSE_A,
      syllabusPointId: null,
      skillLabel: "导数",
      goalPriority: 5,
    });

    const binding = {
      courseId: COURSE_A,
      milestoneId: null,
      packSourceId: PACK_SOURCE_ID,
      boundAt: "2026-10-05T00:00:00.000Z",
      skills: [
        { skillId: "skill-archived-shared-node", nodeId: sharedNode, requirementKey: "req-archived-shared" },
        { skillId: "skill-active-shared-node", nodeId: sharedNode, requirementKey: "req-active-shared" },
        { skillId: "skill-other", nodeId: otherNode, requirementKey: "req-other" },
      ],
      materials: [{ sourceTitle: "真卷", sourceId: PACK_SOURCE_ID, sourceVersion: 1 }],
    };

    const sql = createMockSql((query) => {
      if (query.includes("FROM cards c")) return [labelCardOnSharedNode, labelCardOnOtherNode];
      if (query.includes("FROM opening_exam_papers p")) {
        return [{
          id: uuid("cccccccc", 41),
          sprint_id: SPRINT_ID,
          course_id: COURSE_A,
          source_id: uuid("dddddddd", 41),
          source_version: 1,
          teacher: "陈教授",
          year: 2025,
          label: "2025 真卷",
          kind: "past_exam",
          skills: [
            { skillId: "skill-archived-shared-node", points: 15 },
            { skillId: "skill-active-shared-node", points: 4 },
            { skillId: "skill-other", points: 8 },
          ],
          client_key: "exam-paper-shared-node-archived",
          recorded_at: "2026-10-10T00:00:00.000Z",
          binding,
          pack_snapshot: buildExamPack(skillIds),
          sprint_state: buildExamState(),
        }];
      }
      if (query.includes("FROM opening_course_knowledge g")) {
        return [
          { course_id: COURSE_A, node_id: sharedNode },
          { course_id: COURSE_A, node_id: otherNode },
        ];
      }
      if (query.includes("FROM course_requirements")) {
        return [
          { course_id: COURSE_A, requirement_key: "req-archived-shared", title: "旧极限", knowledge_node_id: sharedNode, lifecycle: "archived" },
          { course_id: COURSE_A, requirement_key: "req-active-shared", title: "极限", knowledge_node_id: sharedNode, lifecycle: "active" },
          { course_id: COURSE_A, requirement_key: "req-other", title: "导数", knowledge_node_id: otherNode, lifecycle: "active" },
        ];
      }
      return [];
    });

    const queue = await listCardQueue(sql, {
      ...SCOPE,
      mode: "auto",
      now,
      timeZone: "Asia/Shanghai",
      maxSessionCards: 200,
    });

    // labelCardOnSharedNode matches ONLY skill-active-shared-node (4 pts) and MUST NOT adopt
    // skill-archived-shared-node (15 pts) through sharedNode, so labelCardOnOtherNode (8 pts) ranks first!
    expect(queue.map((entry) => entry.card.id)).toEqual([
      labelCardOnOtherNode.id,
      labelCardOnSharedNode.id,
    ]);
  });
});
