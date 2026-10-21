"use client";

import type { MeasurementOverview } from "@aistudy/contracts";
import { ArrowLeft, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoadError, LoadingRows, PageHeading, ui } from "../design/ui";
import { MeasurementAttemptCard, type MeasurementAction } from "./attempt-card";
import { createMeasurementClient, type MeasurementCourse } from "./client";
import { activeMeasurementAttempt, measurementCanContinue, measurementDate } from "./measurement-model";
import { MeasurementReportPanel } from "./report-panel";

const api = createMeasurementClient();

export function MeasurementView() {
  const [courses, setCourses] = useState<MeasurementCourse[]>([]);
  const [courseId, setCourseId] = useState("");
  const [overview, setOverview] = useState<MeasurementOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now);
  const requestKeys = useRef(new Map<string, string>());

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const found = await api.courses();
      setCourses(found);
      setCourseId(current => current || found.find(course => course.archivedAt === null)?.id || found[0]?.id || "");
      if (!found.length) setLoading(false);
    } catch {
      setError("课程暂时无法读取，请重试。");
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadCourses(); }, [loadCourses]);
  useEffect(() => {
    if (!courseId) return;
    let current = true;
    setLoading(true);
    setError("");
    setOverview(null);
    setConsent(false);
    void api.read(courseId).then(value => { if (current) { setOverview(value); if (value.trial) setCourseId(value.trial.courseId); } }).catch(cause => {
      if (current) setError(cause instanceof Error ? cause.message : "测试记录暂时无法读取。");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [courseId]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function reload() {
    if (!courseId) return loadCourses();
    setBusy(true);
    setError("");
    try {
      const [found, value] = await Promise.all([api.courses(), api.read(courseId)]);
      setCourses(found);
      setOverview(value);
      if (value.trial) setCourseId(value.trial.courseId);
      setClock(Date.now());
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "测试记录暂时无法读取。"); }
    finally { setBusy(false); }
  }

  async function mutate(key: string, run: (clientKey: string) => Promise<MeasurementOverview>, success: string) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setNotice("");
    const clientKey = requestKeys.current.get(key) ?? crypto.randomUUID();
    requestKeys.current.set(key, clientKey);
    try {
      setOverview(await run(clientKey));
      requestKeys.current.delete(key);
      setClock(Date.now());
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试或重新读取。原始记录仍会保留。");
    } finally { setBusy(false); }
  }

  function act(id: string, action: MeasurementAction) {
    void mutate(`${id}:${JSON.stringify(action)}`, key => api.act(id, { ...action, clientKey: key }), action.action === "retract" ? "已标记无效，原始记录已保留。" : action.action === "answer" ? "答案已保存。" : action.action === "skip" ? "已记录跳过。" : "帮助使用情况已记录。");
  }

  const trial = overview?.trial;
  const attempt = overview ? activeMeasurementAttempt(overview) : null;
  const mostRecent = overview?.attempts.filter(value => value.answeredAt !== null).at(-1);
  const course = courses.find(course => course.id === (trial?.courseId ?? courseId));
  const readOnly = !course || course.archivedAt !== null;
  const courseTitle = course?.title;

  return <div className="min-w-0 bg-surface">
    <PageHeading title="学习测试" description="分部积分小单元：记录真实作答，检查预测与实际表现的差距。" action={<Link href="/opening/settings" className={ui.quiet}><ArrowLeft size={14} aria-hidden="true" />返回设置</Link>} />
    <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-xs text-text-2">关联课程<select className={`${ui.input} mt-2`} value={courseId} disabled={busy || loading} onChange={event => { setNotice(""); setCourseId(event.target.value); }}><option value="" disabled>选择课程</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}{course.archivedAt ? "（已归档）" : ""}</option>)}</select></label>
        <button type="button" className={ui.secondary} disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true" />重新读取</button>
      </div>
      {error ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {loading ? <LoadingRows label="正在读取学习测试" /> : null}
      {!loading && !courses.length && !error ? <div className={`${ui.panel} space-y-3 p-5`}><p className="text-sm text-text-2">先创建用于记录这次测试的课程，再回来开始。</p><Link className={ui.primary} href="/opening/courses">打开课程</Link></div> : null}
      {!loading && overview && !trial && !readOnly ? <section className={`${ui.panel} space-y-4 p-5`}>
        <h2 className="text-base font-medium text-text">开始一次真实学习测试</h2>
        <p className="text-sm leading-7 text-text-2">先做 6 道选择题，随后在初次练习结束 2–4 天、7–10 天内，各做 3 道新题；两轮复测至少相隔 72 小时。迟到的作答仍会保留，并单独标记。内容涵盖分部积分的选法、公式与计算判断，尚不能评价完整证明或书面推导能力。</p>
        <details className="rounded-lg bg-bg p-4 text-sm leading-7 text-text-2"><summary className="cursor-pointer font-medium">先把分部积分的思路串起来</summary><div className="mt-3 space-y-2"><p>把原式拆成 u 和 dv：通常让 u 求导后更简单，同时保证 dv 容易积分。</p><p>接着求 du，并把 dv 积分得到 v。这样，原来的积分就能写成 ∫u dv = uv − ∫v du。</p><p>最后检查新积分 ∫v du 是否更容易计算，再合并结果；不定积分别忘记常数 C。这组题会分别检查选法、公式和计算判断。</p></div></details>
        <p className="text-sm leading-7 text-text-2">练习时可以请求帮助；复测请独立完成。如果看过答案或使用站外帮助，请如实记录。需要时可以暂停，已记录内容会保留。</p>
        <p className="text-xs leading-6 text-text-3">这项测试只收集本题组的作答，比较 BKT 与频率基线的预测；不会改变现有教学安排。个人小样本只能提供线索，不能证明学习效果提升。同一工作区的同一单元只启动一次。</p>
        <p className="text-xs leading-6 text-text-2">备份说明：应用的 Opening 备份暂不包含学习测试记录；本页导出的 JSON 仅供分析，不能恢复测试进度。恢复记录需要由站点管理员使用完整数据库备份。</p>
        <label className="flex items-start gap-2 text-sm leading-6 text-text-2"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-emerald-700" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我愿意记录本次作答、帮助使用、时间与预测，并按约定进行复测。</label>
        <button type="button" className={ui.primary} disabled={!consent || busy || !courseId} onClick={() => void mutate(`start:${courseId}`, key => api.start({ courseId, unitId: "calculus-parts-v1", clientKey: key }), "测试已开启，请开始第一题。")}>启用测试</button>
      </section> : null}
      {!loading && overview && readOnly ? <section className={`${ui.panel} space-y-3 p-5`}>
        <p className="text-sm leading-7 text-text-2">课程已归档，测试记录仍可查看和导出。继续作答或修改记录前，请先恢复课程，再重新读取。</p>
        <Link className={ui.secondary} href="/opening/courses">管理课程</Link>
      </section> : null}
      {!loading && overview && trial ? <>
        <section className={`${ui.panel} p-5`} aria-label="测试进度">
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium text-text">{courseTitle ?? "当前课程"} · {trial.status === "paused" ? "已暂停" : trial.status === "completed" ? "本轮测试完成" : "测试进行中"}</p>{!readOnly && trial.status !== "completed" ? <button type="button" className={ui.quiet} disabled={busy} onClick={() => void mutate(`status:${trial.id}:${trial.status}`, () => api.status({ trialId: trial.id, status: trial.status === "paused" ? "active" : "paused" }), trial.status === "paused" ? "已恢复测试。" : "已暂停测试，记录已保留。")}>{trial.status === "paused" ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{trial.status === "paused" ? "恢复测试" : "暂停"}</button> : null}</div>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-xs text-text-3"><div><dt>已提交</dt><dd className="mt-1 text-lg font-medium text-text">{overview.report.answered} / 12</dd></div><div><dt>有效独立作答</dt><dd className="mt-1 text-lg font-medium text-text">{overview.report.eligible}</dd></div><div><dt>已跳过</dt><dd className="mt-1 text-lg font-medium text-text">{overview.report.skipped}</dd></div></dl>
        </section>
        {!readOnly && trial.status === "active" && attempt ? <MeasurementAttemptCard key={attempt.id} attempt={attempt} busy={busy} onAction={action => act(attempt.id, action)} /> : null}
        {!readOnly && trial.status === "active" && !attempt ? <section className={`${ui.panel} space-y-4 p-5`}>
          {mostRecent?.feedback && !mostRecent.feedbackWithheld ? <p className="whitespace-pre-wrap text-sm leading-7 text-text-2">{mostRecent.feedback}</p> : null}
          {mostRecent?.feedbackWithheld ? <p className="text-sm leading-7 text-text-2">这题已提交。本轮 3 题完成后显示结果与解析。</p> : null}
          {overview.nextDueAt && Date.parse(overview.nextDueAt) > clock ? <p className="text-sm leading-7 text-text-2">下次复测最早开始于 <strong>{measurementDate(overview.nextDueAt)}</strong>。届时回到此页继续，系统会记录实际间隔。</p> : null}
          <button type="button" className={ui.primary} disabled={busy || !measurementCanContinue(overview, clock)} onClick={() => void mutate(`next:${trial.id}:${overview.attempts.length}`, key => api.next({ trialId: trial.id, clientKey: key }), "题目已准备好。")}>{overview.attempts.length === 0 ? "开始第一题" : "继续下一题"}</button>
        </section> : null}
        {!readOnly && trial.status === "paused" ? <p className="text-sm leading-7 text-text-2">测试已暂停。恢复后继续原进度；复测等待时间从初次练习结束计算。</p> : null}
        {trial.status === "completed" ? <p className="text-sm leading-7 text-text-2">本题组已完成。可以查看或导出记录。当前数据仍不足以判断 BKT 是否改善了学习效果。</p> : null}
        <MeasurementReportPanel overview={overview} busy={busy} readOnly={readOnly} onRetract={(id, reason) => act(id, { action: "retract", reason })} />
      </> : null}
      {notice ? <p className="text-sm text-accent" role="status">{notice}</p> : null}
    </div>
  </div>;
}
