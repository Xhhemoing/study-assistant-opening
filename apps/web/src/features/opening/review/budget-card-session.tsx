"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { learningCardSessionCommandSchema, type GradeReviewResponse, type LearningCardSession, type ReviewQueueItem } from "@aistudy/contracts";
import { buildReviewQueue } from "@aistudy/domain";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { CardReviewView } from "../cards/card-review-view";
import { createOpeningCardsClient, type OpeningCardsClient } from "../cards/cards-client";
import { createLearningManagementClient, LearningManagementRequestError, type LearningManagementClient } from "../planning/learning-management-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
type Command = z.infer<typeof learningCardSessionCommandSchema>;
const progressSchema = z.object({ elapsedSeconds: z.number().int().min(0).max(43200), reviewedCardIds: z.array(z.string().uuid()).max(200) });
function pendingKey(namespace: string) { return `aistudy:card-session-command:${namespace}`; }
function readPending(namespace: string | null): Command | null { if (!namespace) return null; try { const raw = sessionStorage.getItem(pendingKey(namespace)); const parsed = raw ? learningCardSessionCommandSchema.safeParse(JSON.parse(raw)) : null; return parsed?.success ? parsed.data : null; } catch { return null; } }
type TriageAwareQueueItem = ReviewQueueItem & {
  syllabusWeight?: number;
  knowledgeUnitKey?: string;
  familyKey?: string;
  delayedCheckCovered?: boolean;
};

function sameCardIdSequence(a: readonly ReviewQueueItem[], b: readonly ReviewQueueItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.card.id !== b[i]?.card.id) return false;
  }
  return true;
}

function compareDueAtAsc(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const aMs = Date.parse(a.state.dueAt);
  const bMs = Date.parse(b.state.dueAt);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
    return aMs - bMs;
  }
  const dueCmp = a.state.dueAt.localeCompare(b.state.dueAt);
  if (dueCmp !== 0) return dueCmp;
  const priorityCmp = b.goalPriority - a.goalPriority;
  if (priorityCmp !== 0) return priorityCmp;
  return a.card.id.localeCompare(b.card.id);
}

function isStrictDueAtAscOrder(items: readonly ReviewQueueItem[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    if (compareDueAtAsc(items[i - 1]!, items[i]!) > 0) return false;
  }
  return true;
}

function courseScopedSkillKey(card: ReviewQueueItem["card"]): string | null {
  const courseId = card.courseId?.trim();
  const skill = card.skillLabel?.trim().toLowerCase();
  if (!courseId || !skill) return null;
  return `${courseId}::${skill}`;
}

/** Matches `deriveCardKnowledgeUnitKey` in `@aistudy/domain` (`packages/domain/src/srs/eligibility.ts`). */
function deriveLocalCardKnowledgeUnitKey(card: ReviewQueueItem["card"]): string | undefined {
  const syllabusPointId = card.syllabusPointId?.trim() || "";
  const skillLabel = card.skillLabel?.trim().toLowerCase() || "";
  if (!syllabusPointId && !skillLabel) return undefined;
  const scope = card.courseId?.trim() || "workspace";
  const unit = syllabusPointId ? `sp:${syllabusPointId}` : `sk:${skillLabel}`;
  const tags = Array.isArray(card.tags) ? card.tags : [];
  const dimension = card.originObservationRootId || tags.includes("review:question")
    ? "question"
    : tags.includes("review:concept")
      ? "concept"
      : "general";
  return `${scope}:${unit}:${dimension}`;
}

/** Matches `deriveCardFamilyKey` in `@aistudy/domain` (`packages/domain/src/srs/eligibility.ts`). */
function deriveLocalCardFamilyKey(card: ReviewQueueItem["card"]): string | undefined {
  const originRoot = card.originObservationRootId?.trim() || "";
  if (originRoot) return `obs:${originRoot}`;
  const skillLabel = card.skillLabel?.trim().toLowerCase() || "";
  if (skillLabel) return `${card.courseId?.trim() || "workspace"}:skill:${skillLabel}`;
  const syllabusPointId = card.syllabusPointId?.trim() || "";
  if (syllabusPointId) return `${card.courseId?.trim() || "workspace"}:sp:${syllabusPointId}`;
  return undefined;
}

function resolveEntryKeys(entry: TriageAwareQueueItem): { ku: string | undefined; fam: string | undefined } {
  const ku = entry.knowledgeUnitKey !== undefined
    ? (entry.knowledgeUnitKey.trim() || undefined)
    : deriveLocalCardKnowledgeUnitKey(entry.card);
  const fam = entry.familyKey !== undefined
    ? (entry.familyKey.trim() || undefined)
    : deriveLocalCardFamilyKey(entry.card);
  return { ku, fam };
}

function addWithCourseSkillPeers(
  target: Set<string>,
  card: ReviewQueueItem["card"],
  peersByCourseSkill: ReadonlyMap<string, readonly string[]>,
): void {
  target.add(card.id);
  const scopedKey = courseScopedSkillKey(card);
  if (!scopedKey) return;
  for (const peerId of peersByCourseSkill.get(scopedKey) ?? []) {
    target.add(peerId);
  }
}

function triageSessionQueue(items: readonly ReviewQueueItem[], now: Date): ReviewQueueItem[] {
  const triagable: TriageAwareQueueItem[] = [];
  const fallback: ReviewQueueItem[] = [];
  for (const item of items) {
    if (item.state && typeof item.state.dueAt === "string") {
      const aware = item as TriageAwareQueueItem;
      triagable.push({
        ...aware,
        goalPriority: typeof aware.goalPriority === "number" ? aware.goalPriority : 0,
      });
    } else {
      fallback.push(item);
    }
  }
  if (!triagable.length) return fallback;
  const today = now.toISOString().slice(0, 10);
  const strictDueAtAsc = isStrictDueAtAscOrder(triagable);

  // Below the 200-card backlog threshold, preserve ordinary `dueAt ASC` order when already in it.
  if (triagable.length < 200 && strictDueAtAsc) {
    return [...triagable, ...fallback];
  }

  const baseline = buildReviewQueue(triagable, "free", now, today, { recoveryTriage: true });
  if (baseline.length !== triagable.length) {
    return [...baseline, ...fallback];
  }
  if (sameCardIdSequence(baseline, triagable)) {
    return [...triagable, ...fallback];
  }

  // Raw dueAt-ASC backlog guard: any >= 200 queue arriving in strict dueAt-ASC order
  // that differs from 5-band recovery triage is untriaged and must be triaged globally before slicing.
  if (triagable.length >= 200 && strictDueAtAsc) {
    return [...baseline, ...fallback];
  }

  // Exact monotone fixed-point solver: reconstructs whether `triagable` is a valid server
  // `listCardQueue` output with server-side `delayedCheckCovered: true` Band-5 demotions.
  const entryById = new Map<string, TriageAwareQueueItem>();
  const peersByCourseSkill = new Map<string, string[]>();
  const keysById = new Map<string, { ku: string | undefined; fam: string | undefined }>();
  const triagableIndexById = new Map<string, number>();
  for (let i = 0; i < triagable.length; i += 1) {
    const entry = triagable[i]!;
    entryById.set(entry.card.id, entry);
    triagableIndexById.set(entry.card.id, i);
    keysById.set(entry.card.id, resolveEntryKeys(entry));
    const scopedKey = courseScopedSkillKey(entry.card);
    if (!scopedKey) continue;
    const list = peersByCourseSkill.get(scopedKey);
    if (list) list.push(entry.card.id);
    else peersByCourseSkill.set(scopedKey, [entry.card.id]);
  }

  // Compute `@aistudy/domain`'s exact intrinsic candidate order once using unique synthetic keys
  // so blocker attribution mirrors `eligibility.ts`'s `seenKnowledgeUnits`/`seenFamilies` pass.
  const intrinsicOrder = buildReviewQueue(
    triagable.map((entry, idx) => ({
      ...entry,
      delayedCheckCovered: false,
      knowledgeUnitKey: `__intr_ku_${idx}`,
      familyKey: `__intr_fam_${idx}`,
    })),
    "free",
    now,
    today,
    { recoveryTriage: true },
  ).map((item) => entryById.get(item.card.id)!);
  const intrinsicRankById = new Map(intrinsicOrder.map((entry, idx) => [entry.card.id, idx]));

  const inferredDelayedIds = new Set<string>();
  for (let step = 0; step <= triagable.length; step += 1) {
    const candidate = step === 0
      ? baseline
      : buildReviewQueue(
        triagable.map((entry) => (
          entry.delayedCheckCovered === true || inferredDelayedIds.has(entry.card.id)
            ? { ...entry, delayedCheckCovered: true }
            : entry
        )),
        "free",
        now,
        today,
        { recoveryTriage: true },
      );
    if (sameCardIdSequence(candidate, triagable)) {
      // Verify SQL group consistency across all cards sharing non-null (courseId, skillLabel).
      const groupConsistent = new Set(inferredDelayedIds);
      for (const entry of triagable) {
        if (entry.delayedCheckCovered === true || inferredDelayedIds.has(entry.card.id)) {
          addWithCourseSkillPeers(groupConsistent, entry.card, peersByCourseSkill);
        }
      }
      if (groupConsistent.size === inferredDelayedIds.size) {
        return [...triagable, ...fallback];
      }
      const verified = buildReviewQueue(
        triagable.map((entry) => (
          entry.delayedCheckCovered === true || groupConsistent.has(entry.card.id)
            ? { ...entry, delayedCheckCovered: true }
            : entry
        )),
        "free",
        now,
        today,
        { recoveryTriage: true },
      );
      return sameCardIdSequence(verified, triagable) ? [...triagable, ...fallback] : [...baseline, ...fallback];
    }

    let mismatchIndex = -1;
    for (let i = 0; i < triagable.length; i += 1) {
      if (candidate[i]?.card.id !== triagable[i]?.card.id) {
        mismatchIndex = i;
        break;
      }
    }
    if (mismatchIndex < 0) break;

    // Mirror `eligibility.ts`'s single-pass `seenKnowledgeUnits`/`seenFamilies` claim order over `intrinsicOrder`.
    const kuOwnerByKey = new Map<string, TriageAwareQueueItem>();
    const famFirstOwnerByKey = new Map<string, TriageAwareQueueItem>();
    for (const intrEntry of intrinsicOrder) {
      if (intrEntry.delayedCheckCovered === true || inferredDelayedIds.has(intrEntry.card.id)) continue;
      const { ku, fam } = keysById.get(intrEntry.card.id) ?? { ku: undefined, fam: undefined };
      if (ku !== undefined && kuOwnerByKey.has(ku)) continue;
      if (ku === undefined && fam !== undefined && famFirstOwnerByKey.has(fam)) continue;
      if (ku !== undefined) kuOwnerByKey.set(ku, intrEntry);
      if (fam !== undefined && !famFirstOwnerByKey.has(fam)) famFirstOwnerByKey.set(fam, intrEntry);
    }

    const expected = triagable[mismatchIndex]!;
    const expectedIntrRank = intrinsicRankById.get(expected.card.id) ?? Number.POSITIVE_INFINITY;
    const expectedKeys = keysById.get(expected.card.id);
    const isBlameable = (item: TriageAwareQueueItem | undefined): item is TriageAwareQueueItem => Boolean(
      item
      && item.delayedCheckCovered !== true
      && !inferredDelayedIds.has(item.card.id)
      && (triagableIndexById.get(item.card.id) ?? -1) > mismatchIndex
      && item.card.skillLabel?.trim(),
    );

    let blamed: TriageAwareQueueItem | null = null;
    // Tier 1: active knowledgeUnitKey owner that precedes `expected` in intrinsic order.
    if (expectedKeys?.ku !== undefined) {
      const kuOwner = kuOwnerByKey.get(expectedKeys.ku);
      if (
        kuOwner
        && kuOwner.card.id !== expected.card.id
        && (intrinsicRankById.get(kuOwner.card.id) ?? Number.POSITIVE_INFINITY) < expectedIntrRank
        && isBlameable(kuOwner)
      ) {
        blamed = kuOwner;
      }
    }
    // Tier 2: active familyKey primary owner that precedes `expected` in intrinsic order.
    if (!blamed && expectedKeys?.fam !== undefined) {
      const famOwner = famFirstOwnerByKey.get(expectedKeys.fam);
      if (
        famOwner
        && famOwner.card.id !== expected.card.id
        && (intrinsicRankById.get(famOwner.card.id) ?? Number.POSITIVE_INFINITY) < expectedIntrRank
        && isBlameable(famOwner)
      ) {
        blamed = famOwner;
      }
    }
    // Tier 3: candidate[mismatchIndex] itself was demoted by server `delayedCheckCovered`.
    if (!blamed) {
      const candidateAtMismatch = entryById.get(candidate[mismatchIndex]?.card.id ?? "");
      if (isBlameable(candidateAtMismatch)) {
        blamed = candidateAtMismatch;
      }
    }

    if (!blamed) break;
    addWithCourseSkillPeers(inferredDelayedIds, blamed.card, peersByCourseSkill);
  }

  return [...baseline, ...fallback];
}
export function BudgetCardSession({ initialActivityId, client: suppliedClient, cardsClient: suppliedCards }: { initialActivityId?: string; client?: Pick<LearningManagementClient, "cardSessions" | "cardCommand">; cardsClient?: OpeningCardsClient }) {
  const client = useMemo(() => suppliedClient ?? createLearningManagementClient(), [suppliedClient]);
  const cards = useMemo(() => suppliedCards ?? createOpeningCardsClient(), [suppliedCards]);
  const [namespace] = useState(getVerifiedSessionNamespace);
  const [session, setSession] = useState<LearningCardSession | null>(null), [queue, setQueue] = useState<ReviewQueueItem[]>([]), [minutes, setMinutes] = useState("10");
  const [pending, setPending] = useState<Command | null>(() => readPending(namespace));
  const [elapsed, setElapsed] = useState(0), [reviewed, setReviewed] = useState<string[]>([]), [busy, setBusy] = useState(false), [gradeBusy, setGradeBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [error, setError] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const writing = useRef(false), active = useRef(true), elapsedRef = useRef(0), reviewedRef = useRef<string[]>([]), loadedAtRef = useRef<Date>(new Date()), current = useRef(session); current.current = session;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function owned() { return namespace === getVerifiedSessionNamespace(); }
  const ownedRef = useRef(owned); ownedRef.current = owned;
  function remember(command: Command | null) { if (!namespace) return false; try { if (command) sessionStorage.setItem(pendingKey(namespace), JSON.stringify(command)); else sessionStorage.removeItem(pendingKey(namespace)); return true; } catch { return false; } }
  function progressKey(activityId: string) { return `aistudy:card-session-progress:${namespace}:${activityId}`; }
  function apply(value: LearningCardSession) {
    let seconds = value.elapsedSeconds, ids = value.reviewedCardIds;
    if (value.status === "active" && namespace) {
      try { const raw = sessionStorage.getItem(progressKey(value.activityId)); const stored = raw ? progressSchema.safeParse(JSON.parse(raw)) : null; if (stored?.success) { seconds = Math.max(seconds, Math.min(value.budgetMinutes * 60, stored.data.elapsedSeconds)); ids = [...new Set([...ids, ...stored.data.reviewedCardIds.filter(id => value.cardIds.includes(id))])]; } } catch { setStorageWarning(true); }
    }
    elapsedRef.current = seconds; reviewedRef.current = ids; setElapsed(seconds); setReviewed(ids); setSession(value);
  }
  useEffect(() => { let live = true; setLoading(true); setError("");
    const id = initialActivityId ?? (pending?.action === "stop" ? pending.activityId : undefined);
    if (id && !z.string().uuid().safeParse(id).success) { setError("卡片活动链接无效，请返回复习入口。"); setLoading(false); return; }
    void Promise.all([cards.listDue("auto"), id ? client.cardSessions(id) : Promise.resolve([])]).then(([items, sessions]) => { if (!live || !ownedRef.current()) return; loadedAtRef.current = new Date(); setQueue(items); if (id) { const exact = sessions.find(value => value.activityId === id); if (!exact) throw new Error("找不到原卡片活动，请核对账号与活动链接；不会新建替代活动。"); apply(exact); } }).catch(reason => { if (live) setError(userFacingMessage(reason, "卡片活动暂不可读取。")); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // An unknown command is kept separately and is never cleared by this read.
  }, [cards, client, initialActivityId, reload, namespace]);
  const saveProgress = useCallback(() => {
    const value = current.current;
    if (!namespace || !value || !ownedRef.current()) return;
    try { sessionStorage.setItem(`aistudy:card-session-progress:${namespace}:${value.activityId}`, JSON.stringify({ elapsedSeconds: Math.floor(elapsedRef.current), reviewedCardIds: reviewedRef.current })); } catch { setStorageWarning(true); }
  }, [namespace]);
  useEffect(() => {
    if (!session || session.status !== "active" || pending) return;
    let previous = Date.now(), visible = document.visibilityState === "visible";
    const tick = () => { const now = Date.now(); if (visible && ownedRef.current()) { elapsedRef.current = Math.min(session.budgetMinutes * 60, elapsedRef.current + Math.max(0, now - previous) / 1000); setElapsed(Math.floor(elapsedRef.current)); saveProgress(); } previous = now; visible = document.visibilityState === "visible"; };
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick); window.addEventListener("pagehide", saveProgress);
    return () => { tick(); window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); window.removeEventListener("pagehide", saveProgress); };
  }, [session, pending, saveProgress]);
  async function execute(command: Command) {
    if (writing.current || !owned()) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setPending(command); setStorageWarning(!remember(command)); saveProgress();
    try { const result = await client.cardCommand(command); if (!owned()) return; remember(null); if (!active.current) return; setPending(null); apply(result); if (command.action === "start") { const params = new URLSearchParams(window.location.search); params.set("cardSession", result.activityId); window.history.replaceState(null, "", `/opening/review?${params}`); window.dispatchEvent(new PopStateEvent("popstate")); } }
    catch (reason) { if (reason instanceof LearningManagementRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && !retryingUnknown) { remember(null); setPending(null); setSession(null); } setError(userFacingMessage(reason, command.action === "stop" ? "停止点保存待确认，请原样重新确认。" : "本次活动创建待确认，请原样重新确认。")); }
    finally { writing.current = false; setBusy(false); }
  }
  function start() {
    const budget = Number(minutes);
    if (!minutes.trim() || !Number.isInteger(budget) || budget < 1 || budget > 120) {
      setError("本次卡片时长须为 1–120 分钟。");
      return;
    }
    const triaged = triageSessionQueue(queue, loadedAtRef.current);
    if (!triaged.length) {
      setError("当前没有可开始的到期卡片。");
      return;
    }
    void execute({
      action: "start",
      budgetMinutes: budget,
      cardIds: triaged.slice(0, 200).map(item => item.card.id),
      goalIds: [],
      clientKey: `card-session:${crypto.randomUUID()}`,
    });
  }
  function stop(reason: "pause" | "finished" | "time_used") { if (!session || pending || gradeBusy) return; void execute({ action: "stop", activityId: session.activityId, expectedRevision: session.revision, elapsedSeconds: Math.floor(elapsedRef.current), reviewedCardIds: [...reviewedRef.current], reason }); }
  const timeUsed = Boolean(session && elapsed >= session.budgetMinutes * 60);
  useEffect(() => { if (timeUsed && session?.status === "active" && !gradeBusy && !pending && !busy) stop("time_used");
  // The current exact stop intent is captured once; a pending request blocks repeats.
  }, [timeUsed, session?.status, gradeBusy, pending, busy]);
  const sessionCardIds = session?.cardIds;
  const limitedCards = useMemo<OpeningCardsClient>(() => ({
    ...cards,
    listDue: async () => {
      if (!sessionCardIds?.length) return [];
      const byId = new Map(queue.map(item => [item.card.id, item]));
      const reviewedSet = new Set(reviewedRef.current);
      const remainingIds = sessionCardIds.filter(id => !reviewedSet.has(id));
      if (remainingIds.some(id => !byId.has(id))) {
        const fallbackItems = await cards.listDue("free");
        for (const item of fallbackItems) {
          if (!byId.has(item.card.id)) byId.set(item.card.id, item);
        }
      }
      return remainingIds.flatMap(id => {
        const item = byId.get(id);
        return item ? [item] : [];
      });
    },
  }), [cards, queue, sessionCardIds]);
  const onGraded = useCallback((cardId: string, _receipt: GradeReviewResponse) => {
    // CardReviewView invokes this only after its typed, persisted grade receipt.
    if (!current.current?.cardIds.includes(cardId) || !ownedRef.current()) return;
    reviewedRef.current = [...new Set([...reviewedRef.current, cardId])]; setReviewed(reviewedRef.current); saveProgress();
  }, [saveProgress]);
  const onBusy = useCallback((value: boolean) => setGradeBusy(value), []);
  return <section className="space-y-3 border-t border-line pt-4" aria-label="限时卡片复习"><h2 className="text-sm font-semibold">本次限时卡片复习</h2><p className="text-xs leading-6 text-text-3">明确本次时长，前台学习用时计入共同预算；离开或隐藏页面不计时。停止点只保留评分结果已确认的卡片，不会把卡片从列表消失当作已完成。</p>
    {loading ? <p className="text-xs text-text-3" role="status">正在读取卡片活动…</p> : !session && !initialActivityId ? <div className="flex flex-wrap items-end gap-3"><label className="space-y-1"><span className={ui.label}>本次卡片分钟</span><input className={ui.input} type="number" min={1} max={120} value={minutes} disabled={busy || Boolean(pending)} onChange={event => setMinutes(event.target.value)} /></label><button className={ui.secondary} type="button" disabled={busy || Boolean(pending) || !queue.length} onClick={start}>开始本次限时复习</button><p className="text-xs text-text-3">{queue.length} 张到期卡片{queue.length > 200 ? "；本次最多纳入前 200 张，其余仍留在队列。" : ""}</p></div> : null}
    {session ? <><p className="text-sm text-text-2">本次 {session.budgetMinutes} 分钟 · 前台已用 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒 · 已确认评分 {reviewed.length}/{session.cardIds.length} 张 · {session.status === "active" ? "进行中" : session.status === "paused" ? "已暂停，停止点已保存" : "本次已结束，记录保留"}</p>
    {session.status === "active" && !pending && (!timeUsed || gradeBusy) ? <fieldset disabled={timeUsed || busy}><CardReviewView key={session.activityId} embedded compact client={limitedCards} onGraded={onGraded} onBusyChange={onBusy} returnTo={session.href} /></fieldset> : null}
    {session.status === "active" ? <div className="flex flex-wrap gap-2"><button className={ui.secondary} type="button" disabled={busy || gradeBusy || Boolean(pending)} onClick={() => stop("pause")}>暂停并保存停止点</button><button className={ui.quiet} type="button" disabled={busy || gradeBusy || Boolean(pending)} onClick={() => stop("finished")}>结束本次复习</button></div> : <p className="text-xs text-text-3">继续复习时请主动开始新的本次活动，原停止点与评分保留。</p>}</> : null}
    {pending ? <div role="status" className="space-y-2"><p className="text-xs text-warn">{pending.action === "stop" ? "停止点保存待确认" : "本次活动创建待确认"}；原时长、卡片和请求保留。</p><button className={ui.secondary} type="button" disabled={busy} onClick={() => void execute(pending)}>{pending.action === "stop" ? "重新确认这次停止点" : "重新确认这次开始"}</button></div> : null}
    {storageWarning ? <p className="text-xs text-warn">恢复信息无法保存，请保留本页；刷新后可能无法找回本页计时或尚未确认的操作。</p> : null}{error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    <div className="flex flex-wrap gap-2"><button className={ui.quiet} type="button" disabled={busy || loading || gradeBusy} onClick={() => setReload(value => value + 1)}>重新读取卡片活动</button><a className={ui.quiet} href="/opening/review?tab=cards">普通卡片复习</a></div>
  </section>;
}
