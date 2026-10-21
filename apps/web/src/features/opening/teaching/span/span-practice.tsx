"use client";

import Link from "next/link";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { learningAttemptSchema, type LearningAttempt, type SpanLessonSnapshot, type LearningObservation, type SpanAnswer, type SpanHintLevel, type SpanHintResponse, type StudySessionIntent, type StudyIntentEvent } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { createOpeningLearningClient } from "../../client/learning-client";
import { assertPracticeAttempt, practiceScope, readPracticeDraft, readPracticeRecord, restoredPracticeAssistance, runPracticeRequest, usePracticeDraft, type PracticeContinuity } from "../../learning/practice-draft";
import { PracticeDraftShelf } from "../../learning/practice-draft-recovery";
import { LearningEvidenceEligibilityDetails } from "../../learning/eligibility-details";
import { StudyContextTools } from "../study-context-tools";
import { ui } from "../../design/ui";
import { useDiagnosticsEnabled } from "../../settings/appearance-preferences";
import { successfulInteractionHaptic } from "../../design/haptics";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
import { SpanFeedback } from "./span-feedback";
import { ProblemCard } from "../problem-card";
import { LessonFlow } from "../lesson-flow";
import { HintLadder } from "../hint-ladder";
import { FeedbackPanel } from "../feedback-panel";
import { LearnerStatePanel } from "../learner-state-panel";
import { MathInput } from "../math-input";
import { nextSpanHintLevel, requestSpanHint, SPAN_HINT_LABELS } from "./span-hint-client";
import { spanProblemText } from "./span-problem-text";
import { readSpanDraftAnswer, SPAN_FEEDBACK_LABELS, spanVectorInput, updateSpanDraftAnswer } from "./span-answer";

export function SpanPractice(props: { session?: SpanLessonSnapshot; restoredAttempt?: LearningAttempt; restoredHintLevels?: SpanHintLevel[]; courseId: string; sourceIds: string[]; problemId: string; intent: StudySessionIntent; intentRevision?: number; newEvidenceEventId?: string; onRecorded: (record: LearningObservation) => void; retestId?: string; onAttempt?: (attempt: LearningAttempt | null) => void; onIntentApplied?: (intent: StudySessionIntent, action: StudyIntentEvent["action"]) => void }) {
  const scope = spanPracticeScope(props.courseId, props.retestId, props.newEvidenceEventId, props.session?.activityId, props.problemId);
  const continuity = usePracticeDraft(scope, { spanProblemId: props.problemId, sourceId: props.sourceIds[0] ?? "", skillLabel: "线性组合与 span", assistance: props.problemId === "span-faded-3d" ? "hinted" : "independent" });
  useEffect(() => { props.onAttempt?.(null); return () => props.onAttempt?.(null); }, [continuity.draft.id, props.onAttempt]);
  return <div className="space-y-4"><SpanPracticeForm key={continuity.draft.id} {...props} continuity={continuity} /><PracticeDraftShelf continuity={continuity} /></div>;
}
function SpanPracticeForm({ courseId, sourceIds, problemId, intent, onRecorded, continuity, retestId, onAttempt, intentRevision, newEvidenceEventId, session, restoredAttempt, restoredHintLevels }: {
  session?: SpanLessonSnapshot; restoredAttempt?: LearningAttempt; restoredHintLevels?: SpanHintLevel[]; courseId: string; sourceIds: string[]; problemId: string; intent: StudySessionIntent; intentRevision?: number; newEvidenceEventId?: string; onRecorded: (record: LearningObservation) => void; continuity: PracticeContinuity; retestId?: string; onAttempt?: (attempt: LearningAttempt | null) => void; onIntentApplied?: (intent: StudySessionIntent, action: StudyIntentEvent["action"]) => void;
}) {
  const diagnostics = useDiagnosticsEnabled();
  const client = useMemo(() => createOpeningLearningClient(), []);
  const { draft, patch, ready, requireSaved } = continuity;
  const scope = spanPracticeScope(courseId, retestId, newEvidenceEventId, session?.activityId, problemId);
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [trustRefreshing, setTrustRefreshing] = useState(false);
  const [record, setRecord] = useState<LearningObservation | null>(null);
  const [sealedAnswer, setSealedAnswer] = useState<string | null>(null);
  const [hints, setHints] = useState<SpanHintResponse[]>([]);
  const [hintPending, setHintPending] = useState(false);
  const [hintRestoring, setHintRestoring] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [why, setWhy] = useState<{ id: string; reasonCodes: string[]; dataAsOf: string } | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fields = draft.fields;
  const differentEntry = fields.spanProblemId !== problemId && !(problemId === "reserved:auto" && fields.spanProblemId.startsWith("span-reserved-"));
  const answer = readSpanDraftAnswer(fields.answer);
  const belongsToRequested = (value: LearningAttempt) => value.spanExercise?.id === problemId || (problemId === "reserved:auto" && value.spanExercise?.id.startsWith("span-reserved-"));
  const nextHint = nextSpanHintLevel(hints);
  function acceptHint(hint: SpanHintResponse) {
    setHints(previous => [...previous.filter(existing => existing.level !== hint.level), hint].sort((a, b) => a.level - b.level));
    patch(current => ({ fields: restoredPracticeAssistance(current.fields, hint.level === 4 ? "revealed" : "hinted") }));
    void acknowledgeStudyExposure(hint.exposureReceipt).catch(() => undefined);
  }
  async function requestNextHint() {
    if (!attempt || !nextHint || locked.current || hintRestoring || (nextHint === 4 && !record) || (draft.submission && !record)) return;
    locked.current = true; setPending(true); setHintPending(true); setError("");
    try { requireSaved(); acceptHint(await requestSpanHint(attempt, nextHint)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提示暂不可读取，原答案保留。"); }
    finally { locked.current = false; setPending(false); setHintPending(false); }
  }
  function edit(change: Parameters<typeof updateSpanDraftAnswer>[1]) { patch({ fields: { answer: updateSpanDraftAnswer(fields.answer, change) } }); }
  async function start() {
    if (!ready || locked.current) return;
    locked.current = true; setPending(true); setError("");
    try {
      const request = patch(current => ({ fields: { stem: current.fields.stem || JSON.stringify(intent) }, start: current.start ?? { sessionId: session?.sessionId ?? null, clientKey: `span-start:${crypto.randomUUID()}`, createInput: null,
        sessionInput: { ...(session ? { activityId: session.activityId } : {}), courseId, skillLabel: "线性组合与 span", sourceIds: [current.fields.sourceId] } } })).start!;
      requireSaved();
      const result = await runPracticeRequest(`${scope}:start:${request.clientKey}`, async () => {
        const currentDraft = readPracticeDraft(scope, null, draft.id) ?? draft;
        if (currentDraft.attemptId) return (await client.getAttemptContext(currentDraft.attemptId)).attempt;
        if (!request.sessionId) {
          request.sessionId = (await client.createSession(request.sessionInput!)).id;
          patch({ start: request }); requireSaved();
        }
        const response = await fetch("/api/opening/teaching/span/session", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: request.sessionId, intent: JSON.parse((readPracticeDraft(scope, null, draft.id) ?? draft).fields.stem) as StudySessionIntent, clientKey: request.clientKey, ...(retestId ? { retestId } : {}), moveId: intent.purpose === "overview" ? fields.spanProblemId === "span-contrast-dependent" ? "overview-contrast" : "overview-mixed" : intent.purpose === "challenge" ? "challenge-transfer" : fields.spanProblemId === "span-faded-3d" ? "self-faded" : "self-independent" }) });
        const planBody: unknown = await response.json();
        if (!response.ok) { const problem = z.object({ error: z.object({ message: z.string() }) }).safeParse(planBody); throw new Error(problem.success ? problem.data.error.message : `学习安排未能保存 (${response.status})；首答草稿保留。`); }
        const plan = z.object({ activityDecision: z.object({ id: z.string().uuid(), reasonCodes: z.array(z.string()), dataAsOf: z.string().datetime() }) }).parse(planBody);
        setWhy(plan.activityDecision);
        if (fields.spanProblemId === "reserved:auto" || request.createInput?.spanExercise?.problemId.startsWith("span-reserved-")) {
          const selected = await fetch("/api/opening/teaching/span/reserved", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: request.sessionId, sourceId: fields.sourceId, clientKey: request.clientKey, mode: intent.purpose === "overview" ? "overview" : intent.purpose === "challenge" ? "challenge" : "self_study" }) });
          if (!selected.ok) throw new Error("检查题或题族已使用，或发放结果暂未确认。可恢复同一请求，不会重复创建。");
          const issued = learningAttemptSchema.parse(await selected.json());
          if (!issued.spanExercise) throw new Error("检查题规格暂不可读取");
          request.createInput = { sessionId: request.sessionId, clientKey: request.clientKey, spanExercise: { sourceId: fields.sourceId, problemId: issued.spanExercise.id, version: Number(issued.spanExercise.version) } };
          patch({ start: request, fields: { spanProblemId: issued.spanExercise.id, spanVersion: Number(issued.spanExercise.version) } }); requireSaved();
          return issued;
        }
        const selectedFields = (readPracticeDraft(scope, null, draft.id) ?? draft).fields;
        request.createInput ??= { sessionId: request.sessionId, clientKey: request.clientKey,
          spanExercise: { sourceId: selectedFields.sourceId, problemId: selectedFields.spanProblemId, version: selectedFields.spanVersion } };
        patch({ start: request }); requireSaved();
        return client.createAttempt(request.createInput);
      });
      assertPracticeAttempt(readPracticeDraft(scope, null, draft.id) ?? draft, result, request.clientKey);
      patch({ attemptId: result.id });
      if (result.spanExercise?.id === "span-faded-3d") {
        acceptHint(await requestSpanHint(result, 1));
      }
      const state = await readPracticeRecord(client, courseId, result, draft.observationId);
      if (!mounted.current) return;
      setAttempt(result); onAttempt?.(result); setRecord(state.observation); setSealedAnswer(state.originalObservation?.answer ?? state.observation?.answer ?? null);
      patch(current => ({ observationId: state.observation?.id ?? null, fields: restoredPracticeAssistance(current.fields, state.deliveredAssistance) }));
      if (state.observation && belongsToRequested(result)) onRecorded(state.observation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "练习暂不可恢复，原请求保留。"); }
    finally { locked.current = false; setPending(false); }
  }
  async function submit() {
    if (!attempt || locked.current) return;
    locked.current = true; setPending(true); setError("");
    try {
      const submission = patch(current => ({ submission: current.submission ?? { attemptId: attempt.id, input: {
        clientKey: `span-first-answer:${crypto.randomUUID()}`, answer: current.fields.answer, ...(retestId ? { retestId } : {}),
        assistance: current.fields.assistance, outcome: "unverified", verdictSource: "self_report",
      } } })).submission!;
      requireSaved();
      const saved = await runPracticeRequest(`${scope}:${submission.input.clientKey}`, () => client.submitAttempt(submission.attemptId, submission.input));
      patch({ observationId: saved.id });
      const state = await readPracticeRecord(client, courseId, { ...attempt, observationId: saved.id });
      if (!state.observation) throw new Error("已收到回执，最新记录暂未读取，请保留原答案重试。");
      if (!mounted.current) return;
      successfulInteractionHaptic();
      setRecord(state.observation); setSealedAnswer(state.originalObservation?.answer ?? state.observation?.answer ?? null); if (belongsToRequested(attempt)) onRecorded(state.observation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存未确认；重试会沿用封存的首答。"); }
    finally { locked.current = false; setPending(false); }
  }
  const intentIdentity = JSON.stringify(intent);
  useEffect(() => {
    if (!attempt || !record) return;
    let active = true; setTrustRefreshing(true);
    void readPracticeRecord(client, courseId, attempt, record.id).then(state => {
      if (active && state.observation) { setTrustRefreshing(false); setRecord(state.observation); setSealedAnswer(state.originalObservation?.answer ?? state.observation?.answer ?? null); onRecorded(state.observation); }
    }).catch(() => { if (active) setError("作答条件已改变，最新资格暂未读取；请重新读取本题。"); });
    return () => { active = false; };
    // Only a newly applied intent refreshes trust; setting the fetched record must not loop.
  }, [intentIdentity, intentRevision]);
  useEffect(() => {
    if (!ready || !session || !restoredAttempt || attempt || draft.start || draft.attemptId) return;
    if (restoredAttempt.courseId !== courseId || restoredAttempt.sessionId !== session.sessionId || !belongsToRequested(restoredAttempt)) return;
    let active = true;
    const problem = restoredAttempt.spanExercise!;
    const sourceId = restoredAttempt.contextAnchor?.sourceId ?? (restoredAttempt.sourceIds.length === 1 ? restoredAttempt.sourceIds[0] : undefined);
    if (!sourceId || !restoredAttempt.sourceIds.includes(sourceId)) {
      setError("原题关联材料暂不可核实，已停止恢复；请保留原答并到课程记录核对。"); return;
    }
    const clientKey = `span-restored:${restoredAttempt.id}`;
    try {
      patch({ fields: { spanProblemId: problem.id, spanVersion: Number(problem.version), sourceId, stem: JSON.stringify(intent) },
        start: { clientKey, sessionId: session.sessionId, sessionInput: { courseId, activityId: session.activityId, skillLabel: "线性组合与 span", sourceIds: [sourceId] },
          createInput: { sessionId: session.sessionId, clientKey, spanExercise: { sourceId, problemId: problem.id, version: Number(problem.version) } } },
        attemptId: restoredAttempt.id, observationId: restoredAttempt.observationId });
      requireSaved();
      void readPracticeRecord(client, courseId, restoredAttempt).then(state => {
        if (!active) return;
        setAttempt(restoredAttempt); onAttempt?.(restoredAttempt); setRecord(state.observation); setSealedAnswer(state.originalObservation?.answer ?? state.observation?.answer ?? null);
        patch(current => ({ observationId: state.observation?.id ?? null, fields: restoredPracticeAssistance(current.fields, state.deliveredAssistance) }));
        if (state.observation) onRecorded(state.observation);
      }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "原题暂未恢复，请重新读取。"); });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "原题草稿暂未保存。"); }
    return () => { active = false; };
    // The captured canonical attempt is restored once; its asynchronous callbacks
    // cannot populate a new lesson or a different draft after navigation.
  }, [ready, session?.activityId, restoredAttempt?.id, draft.id]);
  const hintLevelIdentity = JSON.stringify(restoredHintLevels ?? []);
  useEffect(() => {
    if (!attempt || !restoredAttempt || attempt.id !== restoredAttempt.id || !restoredHintLevels?.length) return;
    let active = true;
    setHintRestoring(true);
    // Only replay levels already released by the server for this exact attempt.
    // A recovery read must never climb the ladder or infer a level from assistance.
    void Promise.all(restoredHintLevels.map(level => requestSpanHint(attempt, level))).then(values => {
      if (active) values.forEach(acceptHint);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "已交付提示暂未恢复，请保留原答并重新读取。"); })
      .finally(() => { if (active) setHintRestoring(false); });
    return () => { active = false; };
  }, [attempt?.id, restoredAttempt?.id, hintLevelIdentity]);
  const problem = attempt?.spanExercise;
  const problemText = problem ? spanProblemText(problem) : null;
  const restoredUnverified = attempt?.spanValidation?.reasonCode === "restored_identity_unverified";
  return <section className="space-y-4 rounded-xl border border-line p-4" aria-label="span 真实作答">
    {!ready ? <p role="status" className="text-sm text-text-3">正在恢复原题、首答与提交请求…</p> : null}
    {continuity.loadError ? <p role="alert" className="text-sm text-danger">{continuity.loadError}</p> : null}
    {continuity.storageWarning ? <p role="alert" className="text-xs text-warn">当前草稿尚未持久保存，已停止发送；请复制答案并恢复浏览器存储。</p> : null}
    {differentEntry ? <div className="space-y-2 text-xs leading-6 text-warn"><p>已恢复另一道题的草稿：{fields.spanProblemId}。切换教学步骤不会覆盖它。</p><button className={ui.secondary} disabled={pending || !ready} onClick={() => continuity.startAnother({ spanProblemId: problemId, sourceId: sourceIds[0] ?? "", skillLabel: "线性组合与 span", assistance: problemId === "span-faded-3d" ? "hinted" : "independent" })} type="button">保留原草稿，开始本步骤的新题</button></div> : null}
    {!attempt ? <div className="space-y-3"><p className="text-sm leading-7">先固定题目与版本。提交前不会提供本题答案；原始作答与后续帮助会进入课程学习记录。</p><label className="block text-xs">关联课程材料<select className={`${ui.input} mt-1`} disabled={Boolean(draft.start) || pending || !ready} value={fields.sourceId} onChange={event => patch({ fields: { sourceId: event.target.value } })}><option value="">选择材料</option>{sourceIds.map(id => <option key={id} value={id}>课程材料 {id.slice(0, 8)}</option>)}</select></label><button type="button" className={ui.primary} disabled={!ready || pending || !fields.sourceId} onClick={() => void start()}>{pending ? "正在固定题目…" : draft.start ? "恢复原题与保存回执" : "开始这道题"}</button></div> : null}
    {problem && problemText ? <ProblemCard language={intent.language} prompt={problemText.english} translation={problemText.chinese}>
      <LessonFlow phase={hintPending ? "hint" : record ? "feedback" : pending ? "submit" : hints.length ? "hint" : "attempt"}>
      {attempt.spanValidation ? <p className="text-xs leading-6 text-text-3">{restoredUnverified ? "已恢复原题身份和作答记录；备份不恢复自动评分权威，本题保留为待核对练习。" : attempt.spanValidation.eligible ? "发题时未见本工作区此前发放同题族的记录；实际帮助与提交时资格仍会核对。" : "本题族已有发放记录，继续作为练习；不称作新的未曝光题族检查。"}</p> : null}{problem.transfer ? <p className="text-xs leading-6 text-text-2">预设迁移：{problem.transfer.changes.join("；")}</p> : null}
      <HintLadder delivered={hints.map(hint => ({ id: hint.exposureReceipt.id, label: `${hint.level}. ${SPAN_HINT_LABELS[hint.level]}`, text: hint.text }))} next={nextHint ? { label: SPAN_HINT_LABELS[nextHint], pending: hintPending || hintRestoring, disabled: pending || hintRestoring || (nextHint === 4 && !record) || Boolean(draft.submission && !record), blockedReason: draft.submission && !record ? "先确认首答保存回执，再继续查看提示。" : nextHint === 4 && !record ? "请先封存自己的首答，再查看完整示范。" : undefined, request: () => void requestNextHint() } : undefined} />
      {record ? <FeedbackPanel verdict={record.serverEvaluation?.decision === "correct" ? "correct" : record.serverEvaluation?.decision === "incorrect" ? "incorrect" : "unverified"} title={record.serverEvaluation?.decision === "correct" ? "本题精确核对通过" : record.serverEvaluation?.decision === "incorrect" ? "本题有需要修正的数学步骤" : "本题暂未能确定判分"} evidence={SPAN_FEEDBACK_LABELS[record.serverEvaluation?.reasonCodes[0] ?? ""] ?? "请到课程学习记录核对评价与版本。"}><LearnerStatePanel observation={record} refreshing={trustRefreshing} />{record.serverEvaluation?.evaluatorVersion === "span-exact-v1" && record.serverEvaluation.skills ? <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">{Object.entries(record.serverEvaluation.skills).map(([key, value]) => <div key={key}><dt className="text-text-3">{{ equation: "建立向量等式", coefficients: "求解系数", allCoordinates: "全部坐标检查", noSolutionProof: "无解证据", systemConsistency: "方程组结构", geometry: "几何集合" }[key] ?? key}</dt><dd className="mt-1">{value === "correct" ? "本次步骤核对正确" : value === "incorrect" ? "本次步骤需修正" : "本次未观察到"}</dd></div>)}</dl> : null}<details><summary className="cursor-pointer text-xs text-text-2">封存的原答案</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{sealedAnswer ?? record.answer}</pre></details>{trustRefreshing ? <p className="text-xs text-warn">作答条件已改变，正在重新核实独立资格…</p> : record.eligibility ? <LearningEvidenceEligibilityDetails eligibility={record.eligibility} /> : null}<SpanFeedback key={attempt.id} attemptId={attempt.id} /><Link href={`/opening/courses/${courseId}#course-learning-records`} className={ui.quiet}>查看记录或修正评价</Link></FeedbackPanel> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={pending || Boolean(draft.submission)} className="space-y-3"><legend className="mb-2 text-sm font-medium">先写自己的等式，再求系数并逐坐标检查</legend>
          <p className="text-xs leading-6 text-text-3">每个向量按逗号分隔；分数写 1/2。以下等式、坐标结果须由你填写，留空表示本次未观察到相应步骤。</p>
          <div className="grid gap-3 sm:grid-cols-3">{(["v", "w", "u"] as const).map((label, index) => <label key={label} className="block text-xs">我的 α(…)+β(…)=… 中的 {label}<input className={`${ui.input} mt-1`} value={(index < 2 ? answer.equation?.vectors[index] : answer.equation?.target)?.join(", ") ?? ""} maxLength={1200} onChange={event => { const equation = answer.equation ?? { vectors: [[], []] as [string[], string[]], target: [] }; const vector = spanVectorInput(event.target.value); edit({ equation: index === 2 ? { ...equation, target: vector } : { ...equation, vectors: index === 0 ? [vector, equation.vectors[1]] : [equation.vectors[0], vector] } }); }} /></label>)}</div>
          <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map(index => <label key={index} className="block text-xs">{index === 0 ? "α" : "β"}（候选系数）<input className={`${ui.input} mt-1`} maxLength={160} value={answer.coefficients?.[index] ?? ""} onChange={event => edit({ coefficients: index === 0 ? [event.target.value, answer.coefficients?.[1] ?? ""] : [answer.coefficients?.[0] ?? "", event.target.value] })} /></label>)}</div>
          <label className="block text-xs">我算出的 αv+βw 各坐标<input className={`${ui.input} mt-1`} value={answer.coordinateChecks?.join(", ") ?? ""} maxLength={1400} onChange={event => edit({ coordinateChecks: spanVectorInput(event.target.value) })} /></label>
          <label className="block text-xs">我的判断<select className={`${ui.input} mt-1`} value={answer.membership ?? ""} required onChange={event => edit({ membership: event.target.value as SpanAnswer["membership"] })}><option value="" disabled>选择</option><option value="in_span">属于 span</option><option value="not_in_span">不属于 span</option></select></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs">方程组的解结构<select className={`${ui.input} mt-1`} value={answer.representations?.system ?? ""} onChange={event => edit({ representations: { ...answer.representations, system: event.target.value as "unique" | "infinite" | "none" } })}><option value="" disabled>我来判断</option><option value="unique">唯一解</option><option value="infinite">无穷多解</option><option value="none">无解</option></select></label><label className="block text-xs">所有组合构成什么几何集合？<select className={`${ui.input} mt-1`} value={answer.representations?.geometry ?? ""} onChange={event => edit({ representations: { ...answer.representations, geometry: event.target.value as "plane" | "line" | "point" } })}><option value="" disabled>我来判断</option><option value="plane">平面</option><option value="line">直线</option><option value="point">一个点</option></select></label></div>
          {answer.membership === "not_in_span" ? <div className="space-y-2 rounded-lg bg-surface-2 p-3"><p className="text-xs leading-6">无解需要证据。若你由两个坐标求出唯一候选系数，再在另一个坐标发现矛盾，请选择你用于求系数的两个坐标；并填写上面的候选系数和全部坐标结果。</p><div className="flex flex-wrap gap-3">{[0, 1].map(index => <label key={index} className="text-xs">导出系数所用坐标 {index + 1}<select className={`${ui.input} mt-1`} value={answer.coefficientDerivationCoordinates?.[index] ?? ""} onChange={event => { const previous = answer.coefficientDerivationCoordinates ?? [-1, -1]; edit({ coefficientDerivationCoordinates: index === 0 ? [Number(event.target.value), previous[1]] : [previous[0], Number(event.target.value)] }); }}><option value="" disabled>请选择</option>{problem.target.map((_, coordinate) => <option key={coordinate} value={coordinate}>第 {coordinate + 1} 坐标</option>)}</select></label>)}</div><label className="block text-xs">或者提供左零空间证书 y（满足 y·v=y·w=0，但 y·u≠0）<input className={`${ui.input} mt-1`} value={answer.noSolutionWitness?.join(", ") ?? ""} onChange={event => edit({ noSolutionWitness: spanVectorInput(event.target.value) })} /></label></div> : null}
          <MathInput label="我的理由（如无解冲突、几何约束）" value={answer.explanation ?? ""} maxLength={6000} disabled={pending || Boolean(draft.submission)} onChange={value => edit({ explanation: value })} />
          <label className="block text-xs">本次帮助<select className={`${ui.input} mt-1`} value={fields.assistance} onChange={event => patch({ fields: { assistance: event.target.value as LearningObservation["assistance"] } })}><option value="independent" disabled={problem.id === "span-faded-3d" || fields.deliveredAssistance !== "none"}>未使用数学帮助</option><option value="hinted">用过数学提示</option><option value="revealed">看过本题解答</option><option value="unknown">尚未确认</option></select></label>
        </fieldset>
        <button type="submit" disabled={pending || !fields.answer || !answer.membership} className={ui.primary}>{pending ? "正在保存首答…" : draft.submission ? "重试保存同一首答" : restoredUnverified ? "封存首答（待重新核对）" : "封存首答并精确核对"}</button>
      </form>}
      </LessonFlow>
      <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs text-text-2">围绕本题提问或记笔记</summary><div className="mt-3"><StudyContextTools context={{ courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId ?? undefined, sourceId: fields.sourceId, sourceVersion: attempt.sourceVersions[fields.sourceId], purpose: "learning_help", label: "线性组合与 span", returnTo: `/opening/courses/${courseId}/study/span` }} isQuestion learningAttempt={attempt} /></div></details>
    </ProblemCard> : null}
    {why ? <details className="text-xs leading-6 text-text-3"><summary className="cursor-pointer">为什么这样安排</summary><p>根据你明确的学习目的选择教学步骤；独立新题检验安排在示范之后。</p><p>记录截止 {why.dataAsOf}。新的作答或意图变化后会重新选择；这条回执保留当时原因。</p>{diagnostics ? <p className="break-all">决策回执 {why.id} · {why.reasonCodes.join(" / ")}</p> : null}</details> : null}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </section>;
}

export function spanPracticeScope(courseId: string, retestId?: string, newEvidenceEventId?: string, activityId?: string, problemId?: string): string {
  const parts = JSON.parse(practiceScope(courseId, "span", retestId ? { retestId, skillLabel: "线性组合与 span", prompt: "span delayed check", requirementKey: SPAN_REQUIREMENT_KEY } : null)) as unknown[];
  // The existing activity and prompt slots isolate this lesson and its step.
  // Legacy drafts keep their exact seven-element scope.
  if (activityId) { parts[3] = activityId; parts[6] = problemId ?? null; }
  if (newEvidenceEventId) parts.push(newEvidenceEventId);
  return JSON.stringify(parts);
}
