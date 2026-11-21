// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LearningCardSession, ReviewCard, ReviewQueueItem, ReviewState } from "@aistudy/contracts";
import { computeCardSessionRecoveryAllowance, writeLearningCardSession } from "@aistudy/database";
import { buildReviewQueue } from "@aistudy/domain";
import type { Sql } from "postgres";
import { BudgetCardSession } from "./budget-card-session";
import type { LearningManagementClient } from "../planning/learning-management-client";
import type { OpeningCardsClient } from "../cards/cards-client";
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "verified-card-test" }));
vi.mock("../cards/card-review-view", () => ({
  CardReviewView: ({
    client,
    onGraded,
    onBusyChange,
  }: {
    client: OpeningCardsClient;
    onGraded: (id: string, result: unknown) => void;
    onBusyChange: (value: boolean) => void;
  }) => {
    const [presentedIds, setPresentedIds] = useState<string[]>([]);
    useEffect(() => {
      let live = true;
      void client.listDue("auto").then((items) => {
        if (live) setPresentedIds(items.map((item) => item.card.id));
      });
      return () => { live = false; };
    }, [client]);
    return (
      <div>
        <p>受限真实卡片队列</p>
        <output data-testid="presented-order">{presentedIds.join(",")}</output>
        <button onClick={() => { onBusyChange(false); onGraded(presentedIds[0] ?? id, { evidence: "saved" }); }}>已收评分回执</button>
      </div>
    );
  },
}));
const id = "11111111-1111-4111-8111-111111111111";
const session: LearningCardSession = { activityId: id, status: "active", revision: 1, cardIds: [id], reviewedCardIds: [], budgetMinutes: 10, elapsedSeconds: 0, startedAt: "2026-10-27T00:00:00Z", stoppedAt: null, href: `/opening/review?cardSession=${id}` };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); window.history.replaceState(null, "", "/opening/review"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
function clients() { return { management: { cardSessions: vi.fn(async () => [session]), cardCommand: vi.fn(async () => session) } as unknown as Pick<LearningManagementClient, "cardSessions" | "cardCommand">, cards: { listDue: vi.fn(async () => [{ card: { id } } as ReviewQueueItem]) } as unknown as OpeningCardsClient }; }
async function render(value: ReturnType<typeof clients>, activityId?: string) { await act(async () => root.render(<BudgetCardSession initialActivityId={activityId} client={value.management} cardsClient={value.cards} />)); }
it("requires an explicit timed-session start and leaves normal card review available", async () => { const value = clients(); await render(value); expect(value.management.cardCommand).not.toHaveBeenCalled(); expect(host.textContent).toContain("本次卡片分钟"); expect(host.querySelector('a[href="/opening/review?tab=cards"]')).toBeTruthy(); await act(async () => button("开始本次限时复习").click()); expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "start", budgetMinutes: 10, cardIds: [id], goalIds: [] })); });
it("restores the exact real session without creating a replacement", async () => { const value = clients(); await render(value, id); expect(value.management.cardSessions).toHaveBeenCalledWith(id); expect(value.management.cardCommand).not.toHaveBeenCalled(); expect(host.textContent).toContain("受限真实卡片队列"); });
it("stops with only acknowledged graded cards and the exact activity revision", async () => { const value = clients(); vi.mocked(value.management.cardCommand).mockResolvedValue({ ...session, status: "paused", revision: 2 }); await render(value, id); await act(async () => button("已收评分回执").click()); await act(async () => button("暂停并保存停止点").click()); expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", activityId: id, expectedRevision: 1, reviewedCardIds: [id], reason: "pause" })); });
it("keeps an unknown stop frozen for an identical retry", async () => { const value = clients(); vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new TypeError("lost")); await render(value, id); await act(async () => button("暂停并保存停止点").click()); const original = vi.mocked(value.management.cardCommand).mock.calls[0]; expect(host.textContent).toContain("停止点保存待确认"); await act(async () => button("重新确认这次停止点").click()); expect(vi.mocked(value.management.cardCommand).mock.calls[1]).toEqual(original); });
it("stops at the explicit budget and excludes hidden page time", async () => {
  vi.useFakeTimers();
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const value = clients(); vi.mocked(value.management.cardSessions).mockResolvedValue([{ ...session, budgetMinutes: 1 }]); vi.mocked(value.management.cardCommand).mockResolvedValue({ ...session, budgetMinutes: 1, status: "completed", revision: 2 });
    await render(value, id);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(value.management.cardCommand).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", elapsedSeconds: 60, reason: "time_used", reviewedCardIds: [] }));
  } finally { vi.useRealTimers(); }
});
it.each([401, 409])("keeps an unknown stop intent after retry status %s", async status => { const { LearningManagementRequestError } = await import("../planning/learning-management-client"); const value = clients(); vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new LearningManagementRequestError("请核对", status)); await render(value, id); await act(async () => button("暂停并保存停止点").click()); const original = vi.mocked(value.management.cardCommand).mock.calls[0]; await act(async () => button("重新确认这次停止点").click()); await act(async () => button("重新读取卡片活动").click()); expect(host.textContent).toContain("停止点保存待确认"); await act(async () => button("重新确认这次停止点").click()); expect(vi.mocked(value.management.cardCommand).mock.calls[2]).toEqual(original); });

it.each(["start", "stop"] as const)("retains the first HTTP 408 %s command across remount and replays it exactly", async action => {
  const { LearningManagementRequestError } = await import("../planning/learning-management-client");
  const value = clients();
  vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new LearningManagementRequestError("request timed out", 408))
    .mockResolvedValue(action === "start" ? session : { ...session, status: "paused", revision: 2 });
  await render(value, action === "stop" ? id : undefined);
  await act(async () => button(action === "start" ? "开始本次限时复习" : "暂停并保存停止点").click());
  const original = vi.mocked(value.management.cardCommand).mock.calls[0];
  expect(JSON.parse(sessionStorage.getItem("aistudy:card-session-command:verified-card-test")!)).toEqual(original![0]);
  await act(async () => root.render(null));
  await render(value, action === "stop" ? id : undefined);
  expect(host.textContent).toContain(action === "start" ? "本次活动创建待确认" : "停止点保存待确认");
  await act(async () => button(action === "start" ? "重新确认这次开始" : "重新确认这次停止点").click());
  expect(vi.mocked(value.management.cardCommand).mock.calls[1]).toEqual(original);
  expect(sessionStorage.getItem("aistudy:card-session-command:verified-card-test")).toBeNull();
});

it("still clears a first definite HTTP 409 card command rejection", async () => {
  const { LearningManagementRequestError } = await import("../planning/learning-management-client");
  const value = clients();
  vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new LearningManagementRequestError("conflict", 409));
  await render(value);
  await act(async () => button("开始本次限时复习").click());
  expect(sessionStorage.getItem("aistudy:card-session-command:verified-card-test")).toBeNull();
  expect([...host.querySelectorAll("button")].some(node => node.textContent === "重新确认这次开始")).toBe(false);
  expect((button("开始本次限时复习") as HTMLButtonElement).disabled).toBe(false);
});

function queueItem(
  cardId: string,
  options: {
    stability: number;
    daysAgo: number;
    dueAt: string;
    goalPriority: number;
    courseId?: string | null;
    skillLabel?: string | null;
    syllabusPointId?: string | null;
    originObservationRootId?: string | null;
    tags?: string[];
  },
  nowMs: number,
): ReviewQueueItem {
  const lastReview = new Date(nowMs - options.daysAgo * 86_400_000).toISOString();
  const card: ReviewCard = {
    id: cardId,
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    front: `Q-${cardId}`,
    back: `A-${cardId}`,
    sourceDocumentId: null,
    syllabusPointId: options.syllabusPointId ?? null,
    tags: options.tags ?? ["review:concept"],
    courseId: options.courseId ?? null,
    skillLabel: options.skillLabel ?? null,
    ...(options.originObservationRootId !== undefined ? { originObservationRootId: options.originObservationRootId } : {}),
    archived: false,
    contentVersion: 1,
    pausedUntil: null,
    maintainUntil: null,
    excludeFromAssessment: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const state: ReviewState = {
    cardId,
    ease: 2.5,
    intervalDays: 1,
    dueAt: options.dueAt,
    reps: 2,
    lapses: 0,
    lastGrade: "good",
    updatedAt: lastReview,
    srsVersion: "fsrs-5.4.2",
    fsrs: {
      stability: options.stability,
      difficulty: 5,
      elapsedDays: 1,
      scheduledDays: Math.max(1, Math.round(options.stability)),
      learningSteps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      lastReview,
    },
  };
  return { card, state, goalPriority: options.goalPriority };
}

it("triages an untriaged 201-card dueAt-sorted queue before the 200-card start cap so high-priority salvageable item #201 is placed first", async () => {
  const nowMs = Date.now();
  const makeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const dueItems: ReviewQueueItem[] = [];
  for (let i = 1; i <= 100; i += 1) {
    dueItems.push(queueItem(
      makeUuid(i),
      { stability: 0.2, daysAgo: 365, dueAt: "2026-07-01T00:00:00.000Z", goalPriority: 0 },
      nowMs,
    ));
  }
  for (let i = 101; i <= 200; i += 1) {
    dueItems.push(queueItem(
      makeUuid(i),
      { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5 },
      nowMs,
    ));
  }
  const criticalId = makeUuid(201);
  dueItems.push(queueItem(
    criticalId,
    { stability: 1.5, daysAgo: 10, dueAt: "2026-08-14T23:00:00.000Z", goalPriority: 8 },
    nowMs,
  ));

  const value = clients();
  vi.mocked(value.cards.listDue).mockResolvedValue(dueItems);
  vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
    ...session,
    cardIds: command.action === "start" ? command.cardIds : session.cardIds,
  }));

  await render(value);
  await act(async () => button("开始本次限时复习").click());

  const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
  expect(startCall?.action).toBe("start");
  if (startCall?.action === "start") {
    expect(startCall.cardIds).toHaveLength(200);
    expect(startCall.cardIds[0]).toBe(criticalId);
  }
});

it("preserves server concept deduplication and delayedCheckCovered Band-5 demotion across 250 single-concept + 20 retest-covered + 150 distinct cards", async () => {
  const now = new Date();
  const nowMs = now.getTime();
  const courseId = "99999999-9999-4999-8999-999999999999";
  const makeUuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const rawServerInputs: Array<ReviewQueueItem & { delayedCheckCovered?: boolean }> = [];
  const limitIds = new Set<string>();
  const retestCoveredIds = new Set<string>();
  const distinctIds = new Set<string>();

  // 250 cards on the single concept "极限"
  for (let i = 1; i <= 250; i += 1) {
    const cid = makeUuid("10000000", i);
    limitIds.add(cid);
    rawServerInputs.push(queueItem(
      cid,
      { stability: 1.5, daysAgo: 10, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: "极限" },
      nowMs,
    ));
  }
  // 20 higher-priority cards already covered by active accepted/in-progress delayed checks
  for (let i = 1; i <= 20; i += 1) {
    const cid = makeUuid("20000000", i);
    retestCoveredIds.add(cid);
    rawServerInputs.push({
      ...queueItem(
        cid,
        { stability: 1.2, daysAgo: 12, dueAt: "2026-08-02T00:00:00.000Z", goalPriority: 9, courseId, skillLabel: `复测知识点-${i}` },
        nowMs,
      ),
      delayedCheckCovered: true,
    });
  }
  // 150 distinct concepts that MUST stay ahead of duplicates and retest-covered cards
  for (let i = 1; i <= 150; i += 1) {
    const cid = makeUuid("30000000", i);
    distinctIds.add(cid);
    rawServerInputs.push(queueItem(
      cid,
      { stability: 1.5, daysAgo: 10, dueAt: "2026-08-03T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `独立概念-${i}` },
      nowMs,
    ));
  }

  // Simulate server listCardQueue triage followed by public API stripping `delayedCheckCovered`.
  const serverTriagedPublic: ReviewQueueItem[] = buildReviewQueue(
    rawServerInputs,
    "auto",
    now,
    now.toISOString().slice(0, 10),
  ).map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));

  const value = clients();
  vi.mocked(value.cards.listDue).mockResolvedValue(serverTriagedPublic);
  vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
    ...session,
    cardIds: command.action === "start" ? command.cardIds : session.cardIds,
  }));

  await render(value);
  await act(async () => button("开始本次限时复习").click());

  const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
  expect(startCall?.action).toBe("start");
  if (startCall?.action === "start") {
    expect(startCall.cardIds).toHaveLength(200);
    const first151 = startCall.cardIds.slice(0, 151);
    // All 150 distinct concepts + exactly 1 primary "极限" card occupy positions 0..150.
    expect(first151.filter((cid) => distinctIds.has(cid))).toHaveLength(150);
    expect(first151.filter((cid) => limitIds.has(cid))).toHaveLength(1);
    expect(first151.filter((cid) => retestCoveredIds.has(cid))).toHaveLength(0);
    // The 20 server-demoted delayedCheckCovered cards stay in the Band-5 tail (positions >= 151).
    expect(startCall.cardIds.slice(151, 171).every((cid) => retestCoveredIds.has(cid))).toBe(true);
  }
});

it("presents active and resumed cards in exact session.cardIds order while skipping reviewed cards", async () => {
  const cardA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cardB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const cardC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const nowMs = Date.now();
  const value = clients();
  vi.mocked(value.cards.listDue).mockResolvedValue([
    queueItem(cardA, { stability: 5, daysAgo: 2, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 1 }, nowMs),
    queueItem(cardB, { stability: 5, daysAgo: 2, dueAt: "2026-08-11T00:00:00.000Z", goalPriority: 1 }, nowMs),
    queueItem(cardC, { stability: 5, daysAgo: 2, dueAt: "2026-08-12T00:00:00.000Z", goalPriority: 1 }, nowMs),
  ]);
  vi.mocked(value.management.cardSessions).mockResolvedValue([
    {
      ...session,
      cardIds: [cardC, cardB, cardA],
      reviewedCardIds: [cardC],
    },
  ]);

  await render(value, id);
  expect(host.querySelector('[data-testid="presented-order"]')?.textContent).toBe(`${cardB},${cardA}`);
});

it("hydrates missing unreviewed resumed session cards from the free queue in exact saved session order", async () => {
  const cardA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cardB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const cardC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const nowMs = Date.now();
  const itemA = queueItem(cardA, { stability: 5, daysAgo: 2, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 1 }, nowMs);
  const itemB = queueItem(cardB, { stability: 5, daysAgo: 2, dueAt: "2026-08-11T00:00:00.000Z", goalPriority: 1 }, nowMs);
  const itemC = queueItem(cardC, { stability: 5, daysAgo: 2, dueAt: "2026-08-12T00:00:00.000Z", goalPriority: 1 }, nowMs);

  const value = clients();
  vi.mocked(value.cards.listDue).mockImplementation(async (mode) => (
    mode === "free" ? [itemA, itemB, itemC] : [itemA]
  ));
  vi.mocked(value.management.cardSessions).mockResolvedValue([
    {
      ...session,
      cardIds: [cardC, cardB, cardA],
      reviewedCardIds: [cardC],
    },
  ]);

  await render(value, id);
  expect(value.cards.listDue).toHaveBeenCalledWith("auto");
  expect(value.cards.listDue).toHaveBeenCalledWith("free");
  expect(host.querySelector('[data-testid="presented-order"]')?.textContent).toBe(`${cardB},${cardA}`);
});

it.each([
  ["course-linked", "99999999-9999-4999-8999-999999999999"],
  ["membership-linked (courseId null)", null],
] as const)(
  "preserves server [C, B, D, A] order when delayedCheckCovered card A overlaps B's knowledgeUnitKey (%s)",
  async (_label, courseId) => {
    const now = new Date();
    const nowMs = now.getTime();
    const sp1 = "10000000-0000-4000-8000-000000000001";
    const sp2 = "10000000-0000-4000-8000-000000000002";
    const sp3 = "10000000-0000-4000-8000-000000000003";
    const cardA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cardB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cardC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const cardD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const rawServerInputs: Array<ReviewQueueItem & { delayedCheckCovered?: boolean }> = [
      {
        ...queueItem(
          cardA,
          { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 8, courseId, skillLabel: "Limits", syllabusPointId: sp1 },
          nowMs,
        ),
        delayedCheckCovered: true,
      },
      queueItem(
        cardB,
        { stability: 1.5, daysAgo: 10, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: null, syllabusPointId: sp1 },
        nowMs,
      ),
      queueItem(
        cardC,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 6, courseId, skillLabel: "Other", syllabusPointId: sp2 },
        nowMs,
      ),
      queueItem(
        cardD,
        { stability: 30, daysAgo: 1, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: null, syllabusPointId: sp3 },
        nowMs,
      ),
    ];

    const serverTriagedPublic: ReviewQueueItem[] = buildReviewQueue(
      rawServerInputs,
      "auto",
      now,
      now.toISOString().slice(0, 10),
      { recoveryTriage: true },
    ).map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));
    expect(serverTriagedPublic.map((item) => item.card.id)).toEqual([cardC, cardB, cardD, cardA]);

    const value = clients();
    vi.mocked(value.cards.listDue).mockResolvedValue(serverTriagedPublic);
    vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
      ...session,
      cardIds: command.action === "start" ? command.cardIds : session.cardIds,
    }));

    await render(value);
    await act(async () => button("开始本次限时复习").click());

    const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
    expect(startCall?.action).toBe("start");
    if (startCall?.action === "start") {
      expect(startCall.cardIds).toEqual([cardC, cardB, cardD, cardA]);
    }
  },
);

it("triages a raw dueAt-ASC 201-card queue even when all 200 Band-4 items and item #201 carry skillLabels", async () => {
  const nowMs = Date.now();
  const courseId = "99999999-9999-4999-8999-999999999999";
  const makeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const dueItems: ReviewQueueItem[] = [];
  for (let i = 1; i <= 200; i += 1) {
    dueItems.push(queueItem(
      makeUuid(i),
      { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `high-ret-${i}` },
      nowMs,
    ));
  }
  const criticalId = makeUuid(201);
  dueItems.push(queueItem(
    criticalId,
    { stability: 1.5, daysAgo: 10, dueAt: "2026-08-14T23:00:00.000Z", goalPriority: 8, courseId, skillLabel: "critical-skill" },
    nowMs,
  ));

  const value = clients();
  vi.mocked(value.cards.listDue).mockResolvedValue(dueItems);
  vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
    ...session,
    cardIds: command.action === "start" ? command.cardIds : session.cardIds,
  }));

  await render(value);
  await act(async () => button("开始本次限时复习").click());

  const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
  expect(startCall?.action).toBe("start");
  if (startCall?.action === "start") {
    expect(startCall.cardIds).toHaveLength(200);
    expect(startCall.cardIds[0]).toBe(criticalId);
  }
});

it("freezes the load-time clock so waiting before clicking start does not drift server-triaged R across band boundaries", async () => {
  vi.useFakeTimers();
  try {
    const loadTime = new Date("2026-08-15T23:59:55.000Z");
    vi.setSystemTime(loadTime);
    const courseId = "99999999-9999-4999-8999-999999999999";
    const sp1 = "10000000-0000-4000-8000-000000000011";
    const sp2 = "10000000-0000-4000-8000-000000000012";
    const cardA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const cardB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

    // Card A's lastReview is 11.99995d ago at loadTime (R > 0.75, Band 4) and crosses to 12d (R <= 0.75, Band 1) 10s later.
    const almostTwelveDaysAgo = new Date(loadTime.getTime() - (12 * 86_400_000 - 5_000)).toISOString();
    const itemA = {
      ...queueItem(cardA, { stability: 2.0, daysAgo: 12, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 9, courseId, skillLabel: "Boundary", syllabusPointId: sp1 }, loadTime.getTime()),
      delayedCheckCovered: true,
    };
    itemA.state = {
      ...itemA.state,
      updatedAt: almostTwelveDaysAgo,
      fsrs: { ...itemA.state.fsrs!, lastReview: almostTwelveDaysAgo },
    };
    const itemB = queueItem(cardB, { stability: 1.5, daysAgo: 10, dueAt: "2026-08-11T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: "StableBand1", syllabusPointId: sp2 }, loadTime.getTime());

    const serverOrder = buildReviewQueue([itemA, itemB], "auto", loadTime, "2026-08-15", { recoveryTriage: true })
      .map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));
    expect(serverOrder.map((entry) => entry.card.id)).toEqual([cardB, cardA]);

    const value = clients();
    vi.mocked(value.cards.listDue).mockResolvedValue(serverOrder);
    vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
      ...session,
      cardIds: command.action === "start" ? command.cardIds : session.cardIds,
    }));

    await render(value);
    // Advance clock past the 12-day boundary before the user clicks start.
    vi.setSystemTime(new Date(loadTime.getTime() + 10_000));
    await act(async () => button("开始本次限时复习").click());

    const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
    expect(startCall?.action).toBe("start");
    if (startCall?.action === "start") {
      expect(startCall.cardIds).toEqual([cardB, cardA]);
    }
  } finally {
    vi.useRealTimers();
  }
});

it("computes card-session recovery allowance with workspace 30% cap, non-backlog maintenance floor, and fail-closed guards", () => {
  expect(computeCardSessionRecoveryAllowance({
    dailyExecutableMinutes: 60,
    freeUnreservedMinutes: 60,
    usedOrReservedCardSessionMinutes: 0,
    isBacklogRecovery: false,
  })).toBe(18);
  expect(computeCardSessionRecoveryAllowance({
    dailyExecutableMinutes: 60,
    freeUnreservedMinutes: 50,
    usedOrReservedCardSessionMinutes: 10,
    isBacklogRecovery: false,
  })).toBe(8);
  expect(computeCardSessionRecoveryAllowance({
    dailyExecutableMinutes: 30,
    freeUnreservedMinutes: 30,
    usedOrReservedCardSessionMinutes: 0,
    isBacklogRecovery: false,
  })).toBe(10);
  expect(computeCardSessionRecoveryAllowance({
    dailyExecutableMinutes: 30,
    freeUnreservedMinutes: 30,
    usedOrReservedCardSessionMinutes: 0,
    isBacklogRecovery: true,
  })).toBe(9);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(computeCardSessionRecoveryAllowance({
      dailyExecutableMinutes: 60,
      freeUnreservedMinutes: 60,
      usedOrReservedCardSessionMinutes: bad,
      isBacklogRecovery: false,
    })).toBe(0);
  }
});

it("enforces the workspace-wide 30% daily card-recovery cap at runtime in writeLearningCardSession before inserting", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const ownerUserId = "22222222-2222-4222-8222-222222222222";
  const cardId = "33333333-3333-4333-8333-333333333333";
  const now = new Date("2026-11-02T09:00:00.000Z");

  function mockCardSessionSql(options: {
    dailyMinutes: number;
    bufferMinutes?: number;
    existingActivities?: Array<Record<string, unknown>>;
    dueCardCount?: number;
  }) {
    let insertCount = 0;
    let insertedRow: Record<string, unknown> | null = null;
    const dueRows = Array.from({ length: options.dueCardCount ?? 1 }, (_, index) => ({
      id: index === 0 ? cardId : `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
      owner_user_id: ownerUserId,
      front: "Q",
      back: "A",
      source_document_id: null,
      syllabus_point_id: null,
      tags: ["review:concept"],
      course_id: null,
      skill_label: null,
      archived: false,
      auto_paused: false,
      content_version: 1,
      paused_until: null,
      maintain_until: null,
      exclude_from_assessment: false,
      created_at: "2026-10-01T00:00:00.000Z",
      ease: 2.5,
      interval_days: 1,
      due_at: "2026-11-01T00:00:00.000Z",
      reps: 0,
      lapses: 0,
      last_grade: null,
      state_updated_at: "2026-11-01T00:00:00.000Z",
      state_owner_user_id: ownerUserId,
      goal_priority: 1,
    }));

    const tx = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) return [];
        if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return [{ revision: 0 }];
        if (query.startsWith("SELECT p.learning_management,p.planning_settings FROM workspaces")) {
          return [{
            learning_management: {
              dailyMinutes: options.dailyMinutes,
              bufferMinutes: options.bufferMinutes ?? 0,
              revision: 1,
              updatedAt: "2026-11-01T00:00:00.000Z",
            },
            planning_settings: {
              weekOneMonday: "2026-09-07",
              periodTimes: {},
              dailyWindow: { start: "08:00", end: "18:00" },
              lunch: { start: "12:00", end: "13:00" },
              dinner: { start: "18:00", end: "19:00" },
              sleep: { start: "23:00", end: "07:00" },
              timeZone: "UTC",
            },
          }];
        }
        if (query.startsWith("SELECT id FROM workspaces")) return [{ id: workspaceId }];
        if (query.includes("client_key=") && query.startsWith("SELECT * FROM opening_teaching_activities")) return [];
        if (query.includes("status='active' LIMIT 1")) return [];
        if (query.startsWith("SELECT id,course_id,status,created_at,updated_at,create_intent,checkpoint_json,goal_json FROM opening_teaching_activities")) {
          return options.existingActivities ?? [];
        }
        if (query.includes("course-route-v1")) return [];
        if (query.startsWith("SELECT t.*,r.id AS retest_id FROM opening_tasks")) return [];
        if (query.startsWith("SELECT day, accepted_blocks FROM opening_plan_state")) return [];
        if (query.startsWith("SELECT id, version, input_snapshot FROM opening_plan_drafts")) return [];
        if (query.includes("INNER JOIN card_review_states s")) return dueRows;
        if (query.startsWith("SELECT c.* FROM cards c WHERE c.id =")) return [dueRows[0]];
        if (query.startsWith("INSERT INTO opening_teaching_activities")) {
          insertCount += 1;
          insertedRow = {
            id: values[0],
            status: "active",
            path_version: 1,
            goal_json: values[3],
            checkpoint_json: values[4],
            create_intent: values[6],
          };
          return [];
        }
        if (query.startsWith("SELECT goal_json FROM opening_teaching_activities")) {
          return insertedRow ? [{ goal_json: insertedRow.goal_json }] : [];
        }
        if (query.startsWith("SELECT create_intent,checkpoint_json,goal_json,course_id FROM opening_teaching_activities")) {
          return insertedRow ? [insertedRow] : [];
        }
        if (query.startsWith("UPDATE opening_teaching_activities SET goal_json=")) {
          if (insertedRow) {
            insertedRow = {
              ...insertedRow,
              goal_json: { ...(insertedRow.goal_json as Record<string, unknown>), ...(values[0] as Record<string, unknown>) },
            };
          }
          return [];
        }
        if (query.startsWith("SELECT * FROM opening_teaching_activities WHERE id=")) {
          return insertedRow ? [insertedRow] : [];
        }
        return [];
      },
      { json: (val: unknown) => val },
    );

    const sql = {
      begin: async <T,>(fn: (client: unknown) => Promise<T>) => fn(tx),
    } as unknown as Sql;

    return { sql, getInsertCount: () => insertCount };
  }

  const scope = { workspaceId, ownerUserId };
  const startCmd = (budgetMinutes: number, key: string) => ({
    action: "start" as const,
    budgetMinutes,
    cardIds: [cardId],
    goalIds: [],
    clientKey: key,
  });

  // 60m day -> 30% cap is 18m: 60m and 19m must fail with CONFLICT before INSERT.
  const sixtyDay = mockCardSessionSql({ dailyMinutes: 60 });
  await expect(writeLearningCardSession(sixtyDay.sql, scope, startCmd(60, "cap-test-60m-01"), now)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(writeLearningCardSession(sixtyDay.sql, scope, startCmd(19, "cap-test-19m-01"), now)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(sixtyDay.getInsertCount()).toBe(0);

  // 60m day after a 10m stopped card session (600s) -> only 8m remaining: second 10m session fails before INSERT.
  const crossCourse = mockCardSessionSql({
    dailyMinutes: 60,
    existingActivities: [{
      id: "44444444-4444-4444-8444-444444444444",
      course_id: null,
      status: "paused",
      created_at: "2026-11-02T08:00:00.000Z",
      updated_at: "2026-11-02T08:10:00.000Z",
      create_intent: { protocol: "card-review-session-v1" },
      goal_json: {
        cardReviewSession: { budgetMinutes: 10 },
        learningBudget: { localDate: "2026-11-02", timeZone: "UTC", minutes: 10 },
      },
      checkpoint_json: {
        cardReviewSession: { elapsedSeconds: 600, stoppedAt: "2026-11-02T08:10:00.000Z" },
      },
    }],
  });
  await expect(writeLearningCardSession(crossCourse.sql, scope, startCmd(10, "cap-test-second-10m"), now)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(crossCourse.getInsertCount()).toBe(0);

  // 30m day with 199 due cards (below 200-card backlog threshold): first 10m session succeeds, 11m fails.
  const thirtyNonBacklog = mockCardSessionSql({ dailyMinutes: 30, dueCardCount: 199 });
  await expect(writeLearningCardSession(thirtyNonBacklog.sql, scope, startCmd(11, "cap-test-30m-11m"), now)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(thirtyNonBacklog.getInsertCount()).toBe(0);
  const allowed = await writeLearningCardSession(thirtyNonBacklog.sql, scope, startCmd(10, "cap-test-30m-10m"), now);
  expect(allowed.budgetMinutes).toBe(10);
  expect(thirtyNonBacklog.getInsertCount()).toBe(1);

  // 30m day at exact 200-card backlog threshold (and 201): strict 30% cap (9m) rejects 10m before INSERT.
  for (const dueCardCount of [200, 201]) {
    const thirtyBacklog = mockCardSessionSql({ dailyMinutes: 30, dueCardCount });
    await expect(writeLearningCardSession(thirtyBacklog.sql, scope, startCmd(10, `cap-test-30m-backlog-${dueCardCount}`), now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(thirtyBacklog.getInsertCount()).toBe(0);
  }
});

it.each([
  ["courseId null membership-linked", "membership", 0],
  ["courseId null membership-linked padded >= 200", "membership", 198],
  ["non-null courseId shared originObservationRootId", "shared-origin", 0],
  ["non-null courseId shared originObservationRootId padded >= 200", "shared-origin", 198],
] as const)(
  "blames active knowledgeUnitKey blocker A instead of C on [P, B, C, A] (%s)",
  async (_label, variant, padCount) => {
    const now = new Date();
    const nowMs = now.getTime();
    const courseId = variant === "shared-origin" ? "99999999-9999-4999-8999-999999999999" : null;
    const obsRoot = "77777777-7777-4777-8777-777777777777";
    const spP = "10000000-0000-4000-8000-000000000010";
    const spA = "10000000-0000-4000-8000-000000000020";
    const spC = "10000000-0000-4000-8000-000000000030";
    const cardP = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cardA = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cardB = "33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cardC = "44444444-cccc-4ccc-8ccc-cccccccccccc";

    const rawServerInputs: Array<ReviewQueueItem & { delayedCheckCovered?: boolean }> = [
      queueItem(
        cardP,
        {
          stability: 1.0,
          daysAgo: 20,
          dueAt: "2026-08-10T00:00:00.000Z",
          goalPriority: 100,
          courseId,
          skillLabel: "Limits",
          syllabusPointId: spP,
          ...(variant === "shared-origin" ? { originObservationRootId: obsRoot, tags: ["review:question"] } : {}),
        },
        nowMs,
      ),
      {
        ...queueItem(
          cardA,
          {
            stability: 1.0,
            daysAgo: 20,
            dueAt: "2026-08-10T00:00:00.000Z",
            goalPriority: 50,
            courseId,
            skillLabel: variant === "shared-origin" ? "Series" : "Limits",
            syllabusPointId: spA,
            ...(variant === "shared-origin" ? { originObservationRootId: obsRoot, tags: ["review:question"] } : {}),
          },
          nowMs,
        ),
        delayedCheckCovered: true,
      },
      queueItem(
        cardB,
        {
          stability: 1.0,
          daysAgo: 20,
          dueAt: "2026-08-10T00:00:00.000Z",
          goalPriority: 30,
          courseId,
          skillLabel: null,
          syllabusPointId: spA,
          ...(variant === "shared-origin" ? { originObservationRootId: null, tags: ["review:question"] } : {}),
        },
        nowMs,
      ),
      queueItem(
        cardC,
        {
          stability: 1.0,
          daysAgo: 20,
          dueAt: "2026-08-10T00:00:00.000Z",
          goalPriority: 10,
          courseId,
          skillLabel: "Other",
          syllabusPointId: spC,
        },
        nowMs,
      ),
    ];

    for (let i = 1; i <= padCount; i += 1) {
      rawServerInputs.push(queueItem(
        `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `pad-${i}` },
        nowMs,
      ));
    }

    const serverTriagedPublic: ReviewQueueItem[] = buildReviewQueue(
      rawServerInputs,
      "auto",
      now,
      now.toISOString().slice(0, 10),
      { recoveryTriage: true },
    ).map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));
    expect(serverTriagedPublic.slice(0, 3).map((item) => item.card.id)).toEqual([cardP, cardB, cardC]);
    expect(serverTriagedPublic.at(-1)?.card.id).toBe(cardA);

    const value = clients();
    vi.mocked(value.cards.listDue).mockResolvedValue(serverTriagedPublic);
    vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
      ...session,
      cardIds: command.action === "start" ? command.cardIds : session.cardIds,
    }));

    await render(value);
    await act(async () => button("开始本次限时复习").click());

    const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
    expect(startCall?.action).toBe("start");
    if (startCall?.action === "start") {
      expect(startCall.cardIds).toEqual(serverTriagedPublic.slice(0, 200).map((item) => item.card.id));
    }
  },
);

it("unconditionally triages a >= 200 strict dueAt-ASC raw queue even when the first 200 already contain Band-1 cards", async () => {
  const nowMs = Date.now();
  const courseId = "99999999-9999-4999-8999-999999999999";
  const makeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const dueItems: ReviewQueueItem[] = [];
  // 1 lower-weight Band-1 card early in the dueAt-ASC head
  dueItems.push(queueItem(
    makeUuid(1),
    { stability: 1.5, daysAgo: 10, dueAt: "2026-07-01T00:00:00.000Z", goalPriority: 2, courseId, skillLabel: "early-band1" },
    nowMs,
  ));
  // 199 Band-4 high-retention cards filling positions 1..199
  for (let i = 2; i <= 200; i += 1) {
    dueItems.push(queueItem(
      makeUuid(i),
      { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `high-ret-${i}` },
      nowMs,
    ));
  }
  // Card #201: higher-weight Band-1 card sitting past index 199 in raw dueAt-ASC order
  const highWeightBand1Id = makeUuid(201);
  dueItems.push(queueItem(
    highWeightBand1Id,
    { stability: 1.5, daysAgo: 10, dueAt: "2026-08-14T23:00:00.000Z", goalPriority: 9, courseId, skillLabel: "late-high-band1" },
    nowMs,
  ));

  const value = clients();
  vi.mocked(value.cards.listDue).mockResolvedValue(dueItems);
  vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
    ...session,
    cardIds: command.action === "start" ? command.cardIds : session.cardIds,
  }));

  await render(value);
  await act(async () => button("开始本次限时复习").click());

  const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
  expect(startCall?.action).toBe("start");
  if (startCall?.action === "start") {
    expect(startCall.cardIds).toHaveLength(200);
    expect(startCall.cardIds[0]).toBe(highWeightBand1Id);
    expect(startCall.cardIds[1]).toBe(makeUuid(1));
  }
});

it.each([
  ["0-padded", 0],
  ["198-padded (>= 200)", 198],
] as const)(
  "uses intrinsic-order kuOwner attribution on [P, E, U, A] so A (not U) is blamed (%s)",
  async (_label, padCount) => {
    const now = new Date();
    const nowMs = now.getTime();
    const courseId = "99999999-9999-4999-8999-999999999999";
    const obsRoot1 = "70000000-0000-4000-8000-000000000001";
    const obsRoot2 = "70000000-0000-4000-8000-000000000002";
    const spP = "10000000-0000-4000-8000-000000000101";
    const spE = "10000000-0000-4000-8000-000000000102";
    const spU = "10000000-0000-4000-8000-000000000103";
    const cardP = "11111111-1111-4111-8111-000000000001";
    const cardA = "22222222-2222-4222-8222-000000000002";
    const cardE = "33333333-3333-4333-8333-000000000003";
    const cardU = "44444444-4444-4444-8444-000000000004";

    const rawServerInputs: Array<ReviewQueueItem & { delayedCheckCovered?: boolean }> = [
      queueItem(
        cardP,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 200, courseId, skillLabel: null, syllabusPointId: spP, originObservationRootId: obsRoot1, tags: ["review:question"] },
        nowMs,
      ),
      {
        ...queueItem(
          cardA,
          { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 100, courseId, skillLabel: "Limits", syllabusPointId: spE, originObservationRootId: obsRoot1, tags: ["review:question"] },
          nowMs,
        ),
        delayedCheckCovered: true,
      },
      queueItem(
        cardE,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-12T00:00:00.000Z", goalPriority: 90, courseId, skillLabel: null, syllabusPointId: spE, originObservationRootId: obsRoot2, tags: ["review:question"] },
        nowMs,
      ),
      queueItem(
        cardU,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 80, courseId, skillLabel: "Derivatives", syllabusPointId: spU, originObservationRootId: obsRoot2, tags: ["review:question"] },
        nowMs,
      ),
    ];

    for (let i = 1; i <= padCount; i += 1) {
      rawServerInputs.push(queueItem(
        `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `pad-${i}` },
        nowMs,
      ));
    }

    const serverTriagedPublic: ReviewQueueItem[] = buildReviewQueue(
      rawServerInputs,
      "auto",
      now,
      now.toISOString().slice(0, 10),
      { recoveryTriage: true },
    ).map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));
    expect(serverTriagedPublic.slice(0, 3).map((item) => item.card.id)).toEqual([cardP, cardE, cardU]);
    expect(serverTriagedPublic.at(-1)?.card.id).toBe(cardA);

    const value = clients();
    vi.mocked(value.cards.listDue).mockResolvedValue(serverTriagedPublic);
    vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
      ...session,
      cardIds: command.action === "start" ? command.cardIds : session.cardIds,
    }));

    await render(value);
    await act(async () => button("开始本次限时复习").click());

    const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
    expect(startCall?.action).toBe("start");
    if (startCall?.action === "start") {
      expect(startCall.cardIds).toEqual(serverTriagedPublic.slice(0, 200).map((item) => item.card.id));
      expect(startCall.cardIds.slice(0, 3)).toEqual([cardP, cardE, cardU]);
      if (padCount > 0) expect(startCall.cardIds).not.toContain(cardA);
    }
  },
);

it.each([
  ["0-padded", 0],
  ["198-padded (>= 200)", 198],
] as const)(
  "resolves 2-hop [P, D, C, H, Q] attribution without falsely blaming H or Q (%s)",
  async (_label, padCount) => {
    const now = new Date();
    const nowMs = now.getTime();
    const courseId = "99999999-9999-4999-8999-999999999999";
    const obsRoot1 = "71000000-0000-4000-8000-000000000001";
    const obsRoot2 = "71000000-0000-4000-8000-000000000002";
    const obsRoot3 = "71000000-0000-4000-8000-000000000003";
    const spP = "11000000-0000-4000-8000-000000000001";
    const spC = "11000000-0000-4000-8000-000000000002";
    const spH = "11000000-0000-4000-8000-000000000003";
    const spQ = "11000000-0000-4000-8000-000000000004";
    const cardP = "12111111-1111-4111-8111-000000000001";
    const cardD = "12222222-2222-4222-8222-000000000002";
    const cardC = "12333333-3333-4333-8333-000000000003";
    const cardH = "12444444-4444-4444-8444-000000000004";
    const cardQ = "12555555-5555-4555-8555-000000000005";

    const rawServerInputs: Array<ReviewQueueItem & { delayedCheckCovered?: boolean }> = [
      queueItem(
        cardP,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 200, courseId, skillLabel: null, syllabusPointId: spP, originObservationRootId: obsRoot1, tags: ["review:question"] },
        nowMs,
      ),
      {
        ...queueItem(
          cardD,
          { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 150, courseId, skillLabel: "Limits", syllabusPointId: spC, originObservationRootId: obsRoot1, tags: ["review:question"] },
          nowMs,
        ),
        delayedCheckCovered: true,
      },
      queueItem(
        cardC,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-12T00:00:00.000Z", goalPriority: 120, courseId, skillLabel: null, syllabusPointId: spC, originObservationRootId: obsRoot2, tags: ["review:question"] },
        nowMs,
      ),
      queueItem(
        cardH,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 110, courseId, skillLabel: "Derivatives", syllabusPointId: spH, originObservationRootId: obsRoot2, tags: ["review:question"] },
        nowMs,
      ),
      queueItem(
        cardQ,
        { stability: 1.0, daysAgo: 20, dueAt: "2026-08-10T00:00:00.000Z", goalPriority: 100, courseId, skillLabel: "Integrals", syllabusPointId: spQ, originObservationRootId: obsRoot3, tags: ["review:question"] },
        nowMs,
      ),
    ];

    for (let i = 1; i <= padCount; i += 1) {
      rawServerInputs.push(queueItem(
        `60000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        { stability: 30, daysAgo: 1, dueAt: "2026-08-01T00:00:00.000Z", goalPriority: 5, courseId, skillLabel: `pad2-${i}` },
        nowMs,
      ));
    }

    const serverTriagedPublic: ReviewQueueItem[] = buildReviewQueue(
      rawServerInputs,
      "auto",
      now,
      now.toISOString().slice(0, 10),
      { recoveryTriage: true },
    ).map(({ card, state, goalPriority }) => ({ card, state, goalPriority }));
    expect(serverTriagedPublic.slice(0, 4).map((item) => item.card.id)).toEqual([cardP, cardC, cardQ, cardH]);
    expect(serverTriagedPublic.at(-1)?.card.id).toBe(cardD);

    const value = clients();
    vi.mocked(value.cards.listDue).mockResolvedValue(serverTriagedPublic);
    vi.mocked(value.management.cardCommand).mockImplementation(async (command) => ({
      ...session,
      cardIds: command.action === "start" ? command.cardIds : session.cardIds,
    }));

    await render(value);
    await act(async () => button("开始本次限时复习").click());

    const startCall = vi.mocked(value.management.cardCommand).mock.calls[0]?.[0];
    expect(startCall?.action).toBe("start");
    if (startCall?.action === "start") {
      expect(startCall.cardIds).toEqual(serverTriagedPublic.slice(0, 200).map((item) => item.card.id));
      expect(startCall.cardIds.slice(0, 4)).toEqual([cardP, cardC, cardQ, cardH]);
      if (padCount > 0) expect(startCall.cardIds).not.toContain(cardD);
    }
  },
);
