"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { learningCardSessionCommandSchema, type GradeReviewResponse, type LearningCardSession, type ReviewQueueItem } from "@aistudy/contracts";
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
export function BudgetCardSession({ initialActivityId, client: suppliedClient, cardsClient: suppliedCards }: { initialActivityId?: string; client?: Pick<LearningManagementClient, "cardSessions" | "cardCommand">; cardsClient?: OpeningCardsClient }) {
  const client = useMemo(() => suppliedClient ?? createLearningManagementClient(), [suppliedClient]);
  const cards = useMemo(() => suppliedCards ?? createOpeningCardsClient(), [suppliedCards]);
  const [namespace] = useState(getVerifiedSessionNamespace);
  const [session, setSession] = useState<LearningCardSession | null>(null), [queue, setQueue] = useState<ReviewQueueItem[]>([]), [minutes, setMinutes] = useState("10");
  const [pending, setPending] = useState<Command | null>(() => readPending(namespace));
  const [elapsed, setElapsed] = useState(0), [reviewed, setReviewed] = useState<string[]>([]), [busy, setBusy] = useState(false), [gradeBusy, setGradeBusy] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [error, setError] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const writing = useRef(false), active = useRef(true), elapsedRef = useRef(0), reviewedRef = useRef<string[]>([]), current = useRef(session); current.current = session;
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
    void Promise.all([cards.listDue("auto"), id ? client.cardSessions(id) : Promise.resolve([])]).then(([items, sessions]) => { if (!live || !ownedRef.current()) return; setQueue(items); if (id) { const exact = sessions.find(value => value.activityId === id); if (!exact) throw new Error("找不到原卡片活动，请核对账号与活动链接；不会新建替代活动。"); apply(exact); } }).catch(reason => { if (live) setError(userFacingMessage(reason, "卡片活动暂不可读取。")); }).finally(() => { if (live) setLoading(false); });
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
    catch (reason) { if (reason instanceof LearningManagementRequestError && reason.status >= 400 && reason.status < 500 && !retryingUnknown) { remember(null); setPending(null); setSession(null); } setError(userFacingMessage(reason, command.action === "stop" ? "停止点保存待确认，请原样重新确认。" : "本次活动创建待确认，请原样重新确认。")); }
    finally { writing.current = false; setBusy(false); }
  }
  function start() { const budget = Number(minutes); if (!minutes.trim() || !Number.isInteger(budget) || budget < 1 || budget > 120) { setError("本次卡片时长须为 1–120 分钟。"); return; } if (!queue.length) { setError("当前没有可开始的到期卡片。"); return; } void execute({ action: "start", budgetMinutes: budget, cardIds: queue.slice(0, 200).map(item => item.card.id), goalIds: [], clientKey: `card-session:${crypto.randomUUID()}` }); }
  function stop(reason: "pause" | "finished" | "time_used") { if (!session || pending || gradeBusy) return; void execute({ action: "stop", activityId: session.activityId, expectedRevision: session.revision, elapsedSeconds: Math.floor(elapsedRef.current), reviewedCardIds: [...reviewedRef.current], reason }); }
  const timeUsed = Boolean(session && elapsed >= session.budgetMinutes * 60);
  useEffect(() => { if (timeUsed && session?.status === "active" && !gradeBusy && !pending && !busy) stop("time_used");
  // The current exact stop intent is captured once; a pending request blocks repeats.
  }, [timeUsed, session?.status, gradeBusy, pending, busy]);
  const limitedCards = useMemo<OpeningCardsClient>(() => ({ ...cards, listDue: async () => queue.filter(item => session?.cardIds.includes(item.card.id) && !reviewedRef.current.includes(item.card.id)) }), [cards, queue, session?.activityId, session?.cardIds]);
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
