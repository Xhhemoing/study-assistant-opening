import { z } from "zod";
import { spanProblemSchema, learningAttemptSchema, type LearningAttempt, type LearningObservation, type SpanHintLevel, type SpanLessonSnapshot } from "@aistudy/contracts";
import { createSpanTeachingSequence, spanModeForIntent, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { createOpeningLearningClient } from "../../client/learning-client";
import { createOpeningApi, resolveUploadPutUrl } from "../../client/api";
import { createMaterialOrganizationClient } from "../../library/material-organization-client";
import { createUploadClient } from "../../inbox/upload-client";
import { putPrivateBytes } from "../../inbox/put-private";
import { spanLessonRequest, type SpanLessonDetails } from "../../teaching/span/span-session-client";
import { requestSpanHint } from "../../teaching/span/span-hint-client";
import { spanProblemText } from "../../teaching/span/span-problem-text";
import { isSpanReservedProblemId } from "../../teaching/span/span-answer";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
import { emptyPracticeDraft, readPracticeDraft, initializePracticeDraft, patchPracticeDraft, assertPracticeDraftSaved, practiceScope } from "../../learning/practice-draft-storage";
import { readPracticeRecord } from "../../learning/practice-draft";
import type { AnswerField, HelpState, NextAction, PhotoState, StepResult, StudySessionPort, StudySessionView, StudyStep } from "../model";

const options = (values: [string, string][]) => values.map(([value, label]) => ({ value, label }));
const fields: AnswerField[] = [
  ...["v", "w", "u"].map(key => ({ key, label: `我的向量等式中的 ${key}（逗号分隔）` })),
  { key: "alpha", label: "α" }, { key: "beta", label: "β" }, { key: "checks", label: "αv+βw 的各坐标（逗号分隔）" },
  { key: "membership", label: "我的判断", options: options([["in_span", "属于 span"], ["not_in_span", "不属于 span"]]) },
  { key: "system", label: "方程组的解", options: options([["unique", "唯一解"], ["infinite", "无穷多解"], ["none", "无解"]]) },
  { key: "geometry", label: "所有组合的几何集合", options: options([["plane", "平面"], ["line", "直线"], ["point", "一个点"]]) },
  { key: "witness", label: "无解时的左零空间证书 y（逗号分隔，可选）" }, { key: "explanation", label: "我的理由" },
];
export function adaptSpanQuestion(attempt: LearningAttempt, estimateMinutes: number | null = null, photoEnabled = false): Extract<StudyStep, { kind: "question" }> {
  if (!attempt.spanExercise) throw new Error("原题暂不可读，请到课程记录核对。");
  return { kind: "question", id: attempt.id, title: "线性组合与 span", prompt: spanProblemText(attempt.spanExercise).chinese, answerModes: photoEnabled ? ["text", "photo"] : ["text"], hintsAvailable: 4, estimateMinutes, attemptRef: { id: attempt.id, itemVersionId: attempt.itemVersionId }, fields };
}
export function adaptSpanResult(record: LearningObservation, grading?: string): StepResult {
  const decision = record.serverEvaluation?.decision;
  const outcome = decision === "correct" || decision === "incorrect" ? decision : grading === "queued" || grading === "grading" ? "pending" : grading === "needs_manual" ? "needs_manual" : "unknown";
  return { outcome, assistance: record.assistance, reasonCode: record.serverEvaluation?.reasonCodes[0] };
}
export function adaptSpanHelp(level: HelpState["level"], levels: number[], texts: string[], submitted: boolean): HelpState {
  const latest = Math.max(0, ...levels);
  return { level, hintsShown: levels.length, tutorAsked: false, texts, canRequest: latest < (submitted ? 4 : 3) };
}
const link = z.object({ href: z.string(), label: z.string() });
const nextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), href: z.string(), label: z.string(), activityId: z.string().uuid(), sessionId: z.string().uuid(), courseId: z.string().uuid(), resumed: z.boolean() }),
  z.object({ kind: z.literal("choice"), reason: z.string(), primary: link, secondary: link.optional() }),
]);
export function adaptSpanNext(raw: unknown, courseId: string): NextAction {
  const next = nextSchema.parse(raw);
  function safe(href: string) {
    const url = new URL(href, "https://opening.local"), base = `/opening/courses/${courseId}`;
    if (!href.startsWith("/") || href.startsWith("//") || /[\\\s]/.test(href) || url.origin !== "https://opening.local" || ![base, `${base}/study`, `${base}/study/span`].includes(url.pathname)) throw new Error("下一步与当前课程不一致。");
    if (next.kind === "ready" && (next.courseId !== courseId || url.pathname !== `${base}/study/span` || url.searchParams.get("lesson") !== next.activityId || url.searchParams.getAll("lesson").length !== 1 || url.hash || [...url.searchParams.keys()].some(key => key !== "lesson" && key !== "retest"))) throw new Error("下一步入口不完整。");
    return href;
  }
  return next.kind === "ready" ? { action: safe(next.href), label: next.label, estimateMinutes: null, reasonCode: null, alternatives: [] }
    : { action: safe(next.primary.href), label: next.primary.label, estimateMinutes: null, reasonCode: next.reason, alternatives: next.secondary ? [{ action: safe(next.secondary.href), label: next.secondary.label }] : [] };
}
const presentationSchema = z.object({ problem: spanProblemSchema, exposureReceipt: z.object({ id: z.string().uuid() }), solution: z.object({ kind: z.string(), coefficients: z.tuple([z.string(), z.string()]).optional() }) });
export function adaptSpanLearn(raw: unknown, id: string, estimateMinutes: number | null = null, targetedFocus?: string): StudyStep {
  const content = presentationSchema.parse(raw), problem = content.problem;
  const solution = content.solution.coefficients;
  return { kind: "learn", id, title: "线性组合与 span", estimateMinutes, targetedFocus, body: `${spanProblemText(problem).chinese}\n\nspan 是所有 αv+βw 的集合。先建立向量等式，再让每一个坐标同时成立。\nα(${problem.vectors[0].join(",")})+β(${problem.vectors[1].join(",")})=(${problem.target.join(",")})${solution ? `\n本例 α=${solution[0]}，β=${solution[1]}。将系数代回每个坐标核对。` : ""}` };
}

/** Owns all API shapes and durable request identities; UI receives only the port/model. */
export function createSpanStudySession(details: SpanLessonDetails, save: (intent: SpanLessonSnapshot["intent"], move: string, status: "active" | "paused" | "completed") => Promise<boolean>, options: { photoEnabled?: boolean } = {}): StudySessionPort {
  const session = details.session!;
  const retestId = session.retestId;
  const availableSourceId = session.sourceIds[0];
  if (!availableSourceId) throw new Error("请先恢复课程材料，再继续学习。");
  const lessonSourceId: string = availableSourceId;
  const client = createOpeningLearningClient();
  const openingApi = createOpeningApi();
  const upload = createUploadClient({ begin: input => openingApi.beginUpload(input), complete: id => openingApi.completeUpload(id), put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, loaded => onProgress(loaded)), resolvePutUrl: resolveUploadPutUrl, refreshTicket: id => openingApi.refreshUploadTicket(id) });
  const mode = spanModeForIntent(session.intent), sequence = createSpanTeachingSequence(mode);
  const index = sequence.findIndex(move => move.id === session.moveId);
  const learn = !retestId && index === 0;
  const problemId = (retestId || index < 0) ? "reserved:auto" : mode === "self_study" ? index === 1 ? "span-faded-3d" : "span-independent-3d" : mode === "overview" ? index === 1 ? "span-contrast-dependent" : "span-geometry-transfer" : "span-geometry-transfer";
  // Match SpanPractice's existing durable scope so switching shells restores the same owner.
  const scopeParts = JSON.parse(practiceScope(session.courseId, "span", retestId ? { retestId, skillLabel: "线性组合与 span", prompt: "span delayed check", requirementKey: SPAN_REQUIREMENT_KEY } : null)) as unknown[];
  scopeParts[3] = session.activityId; scopeParts[6] = problemId;
  const scope = JSON.stringify(scopeParts);
  let view: StudySessionView, attempt: LearningAttempt, record: LearningObservation | null = null;
  let levels: SpanHintLevel[] = [], texts: string[] = [];
  let assistance: HelpState["level"] = "none";
  const storage = () => window.sessionStorage;
  const draft = () => readPracticeDraft(scope, storage())!;
  const update = (change: Parameters<typeof patchPracticeDraft>[2]) => { const result = patchPracticeDraft(scope, {}, change, storage()); assertPracticeDraftSaved(scope); return result.draft; };
  let photo: PhotoState = { enabled: options.photoEnabled === true, status: "none" };
  const helpState = () => retestId && !record ? { ...adaptSpanHelp(assistance, levels, [], false), canRequest: false } : adaptSpanHelp(assistance, levels, texts, Boolean(record));
  const refresh = () => { view = { ...view, photo, help: helpState(), result: record ? adaptSpanResult(record) : null, locked: Boolean(draft().submission) }; return view; };
  async function load(): Promise<StudySessionView> {
    if (learn) {
      const raw = await spanLessonRequest("/api/opening/teaching/span/presentation", presentationSchema, { method: "POST", body: JSON.stringify({ courseId: session.courseId, sourceId: lessonSourceId, sessionId: session.sessionId, kind: mode === "overview" ? "overview" : mode === "challenge" ? "simulation" : "worked", clientKey: `span-demo:${session.sessionId}:${lessonSourceId}:${mode === "overview" ? "overview" : mode === "challenge" ? "simulation" : "worked"}:v1` }) });
      await acknowledgeStudyExposure(raw.exposureReceipt);
      return view = { step: adaptSpanLearn(raw, session.moveId, details.estimateMinutes ?? null, details.targetedFocus), help: adaptSpanHelp("none", [], [], false), result: null, next: null, answer: {}, locked: false, photo };
    }
    initializePracticeDraft(readPracticeDraft(scope, storage()) ?? emptyPracticeDraft(scope, { sourceId: lessonSourceId, spanProblemId: problemId, skillLabel: "线性组合与 span", assistance: "independent" }));
    const evidence = details.intentEvent?.signals.some(signal => signal === "guessed" || signal === "copied_answer") ? details.intentEvent : null;
    const restored = [...details.attempts].filter(row => retestId || !evidence || !isSpanReservedProblemId(row.spanExercise?.id) || row.startedAt >= evidence.createdAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).find(row => problemId === "reserved:auto" ? isSpanReservedProblemId(row.spanExercise?.id) : row.spanExercise?.id === problemId);
    if (draft().attemptId) attempt = (await client.getAttemptContext(draft().attemptId!)).attempt;
    else if (restored) attempt = restored;
    else {
      const start = update(current => ({ start: current.start ?? { clientKey: `span-start:${crypto.randomUUID()}`, sessionId: session.sessionId, sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [lessonSourceId], skillLabel: "线性组合与 span" }, createInput: null } })).start!;
      await spanLessonRequest("/api/opening/teaching/span/session", z.unknown(), { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, intent: session.intent, clientKey: start.clientKey, moveId: session.moveId, ...(retestId ? { retestId } : {}) }) });
      attempt = problemId === "reserved:auto" ? await spanLessonRequest("/api/opening/teaching/span/reserved", learningAttemptSchema, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, sourceId: lessonSourceId, clientKey: start.clientKey, mode }) }) : await client.createAttempt({ sessionId: session.sessionId, clientKey: start.clientKey, spanExercise: { sourceId: lessonSourceId, problemId, version: 1 } });
    }
    if (attempt.courseId !== session.courseId || attempt.sessionId !== session.sessionId || !attempt.spanExercise || retestId && !isSpanReservedProblemId(attempt.spanExercise.id)) throw new Error("原题身份已变化，请重新读取。");
    const sourceId = attempt.contextAnchor?.sourceId ?? attempt.sourceIds[0];
    if (!sourceId || !attempt.sourceIds.includes(sourceId)) throw new Error("原题关联材料暂不可核实。");
    update(current => ({ attemptId: attempt.id, start: { clientKey: current.start?.clientKey ?? `span-restored:${attempt.id}`, sessionId: session.sessionId, sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [sourceId], skillLabel: "线性组合与 span" }, createInput: { sessionId: session.sessionId, clientKey: current.start?.clientKey ?? `span-restored:${attempt.id}`, spanExercise: { sourceId, problemId: attempt.spanExercise!.id, version: Number(attempt.spanExercise!.version) } } }, fields: { spanProblemId: attempt.spanExercise!.id, spanVersion: Number(attempt.spanExercise!.version), sourceId } }));
    const state = await readPracticeRecord(client, session.courseId, attempt, draft().observationId);
    record = state.observation; assistance = state.deliveredAssistance === "revealed" || draft().fields.deliveredAssistance === "revealed" ? "revealed" : state.deliveredAssistance === "hinted" || draft().fields.deliveredAssistance === "hinted" ? "hinted" : "none";
    levels = [...new Set([...levels, ...(details.hintLevels[attempt.id] ?? [])])];
    // Hiding help does not erase already delivered help or its evidence eligibility.
    if (retestId) {
      const prior = [assistance, draft().fields.assistance, details.assistance[attempt.id]];
      assistance = prior.includes("revealed") || levels.includes(4) ? "revealed" : prior.includes("hinted") || levels.length ? "hinted" : "none";
      update({ fields: { deliveredAssistance: assistance } });
    }
    if (problemId === "span-faded-3d" && (details.executionPhase?.phase ?? session.intent.learningPhase) !== "consolidate" && !levels.length) {
      await requestSpanHint(attempt, 1); levels = [1]; assistance = "hinted";
    }
    texts = retestId && !record ? [] : await Promise.all(levels.map(async level => (await requestSpanHint(attempt, level)).text));
    const savedPhoto = draft().fields.workSourceId ? { id: draft().fields.workSourceId, version: draft().fields.workSourceVersion, physicalPage: draft().fields.workPhysicalPage } : undefined;
    photo = { enabled: options.photoEnabled === true, status: savedPhoto ? "preparing" : "none", workSource: savedPhoto };
    if (savedPhoto) {
      try {
        const checked = await client.preparePhotoWorkSource(attempt.id, { sourceId: savedPhoto.id, sourceVersion: savedPhoto.version, physicalPage: savedPhoto.physicalPage });
        photo = { enabled: options.photoEnabled === true, status: checked.state, workSource: checked.workSource,
          message: checked.state === "pending" ? "照片已保存，解析仍在进行。" : checked.state === "unavailable" ? "照片暂不可用于本题，文字作答仍可继续。" : undefined };
        if (checked.state === "ready") update({ fields: { workSourceId: checked.workSource.id, workSourceVersion: checked.workSource.version, workPhysicalPage: checked.workSource.physicalPage } });
      } catch (reason) {
        photo = { enabled: options.photoEnabled === true, status: "unavailable", workSource: savedPhoto, message: reason instanceof Error ? reason.message : "照片当前不可核实，文字作答仍可继续。" };
      }
    }
    const question = adaptSpanQuestion(attempt, details.estimateMinutes ?? null, options.photoEnabled);
    view = { step: { ...question, purpose: retestId ? "retest" : "practice", ...(retestId ? { title: "线性组合与 span · 延迟复测", hintsAvailable: 0 } : {}) }, help: helpState(), result: record ? adaptSpanResult(record) : null, next: null, answer: decodeAnswer(draft().fields.answer), locked: Boolean(draft().submission), photo };
    return view;
  }
  return { load,
    edit(key, value) { if (draft().submission) throw new Error("原答案已提交，请先确认保存结果。"); const answer = { ...view.answer, [key]: value }; update({ fields: { answer: encodeAnswer(answer, draft().fields.answer) } }); view = { ...view, answer }; return view; },
    async primary() {
      if (learn) { if (!await save(session.intent, sequence[1]!.id, "active")) throw new Error("学习进度尚未保存。"); return view; }
      if (record) { view = { ...view, next: adaptSpanNext(await spanLessonRequest("/api/opening/teaching/span/next", z.unknown(), { method: "POST", body: JSON.stringify({ activityId: session.activityId, expectedRevision: session.revision, observationId: record.id, clientKey: `span-next:${session.activityId}:${session.revision}:${record.id}` }) }), session.courseId) }; return view; }
      // Replay the durable sealed request before checking the current photo candidate.
      const savedSubmission = draft().submission;
      const currentPhoto = photo.status === "ready" && photo.workSource ? photo.workSource : null;
      if (!savedSubmission && photo.status !== "none" && !currentPhoto) throw new Error("照片还没准备好；请移除附件后继续文字作答，或重新选择照片。");
      const submission = savedSubmission ?? update(current => ({ submission: { attemptId: attempt.id, input: { clientKey: `span-first-answer:${crypto.randomUUID()}`, answer: current.fields.answer, assistance: assistance === "none" ? (retestId && current.fields.assistance === "unknown" ? "unknown" : "independent") : assistance, outcome: "unverified", verdictSource: "self_report", ...(retestId ? { retestId } : {}), ...(currentPhoto ? { workSource: currentPhoto } : {}) } } })).submission!;
      const saved = await client.submitAttempt(submission.attemptId, submission.input); update({ observationId: saved.id });
      record = (await readPracticeRecord(client, session.courseId, attempt, saved.id)).observation;
      if (!record) throw new Error("最新结果尚未读取，原答案已保留。");
      return refresh();
    },
    async choosePhoto(file: File) {
      if (!photo.enabled) return view;
      if (draft().submission) throw new Error("原答案已封存，不能更换照片附件。");
      // A replacement must detach the old candidate before any remote work. A
      // failed upload/ownership/prepare can therefore never submit A silently.
      update({ fields: { workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 } });
      photo = { enabled: true, status: "uploading", name: file.name };
      view = { ...view, photo };
      try {
        const result = await upload.uploadFile({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
        if ("phase" in result) { photo = { enabled: true, status: "failed", name: file.name, message: result.message }; return refresh(); }
        const membership = await createMaterialOrganizationClient().addToCourse(session.courseId, [result.id], "reference");
        if (membership.failed.length) { photo = { enabled: true, status: "unavailable", name: file.name, message: "照片已保存，但归入当前课程未完成；文字作答仍可继续。" }; return refresh(); }
        photo = { enabled: true, status: "preparing", name: file.name };
        // Keep the uploaded candidate across refresh even when preparation is pending.
        update({ fields: { workSourceId: result.id, workSourceVersion: result.version, workPhysicalPage: 1 } });
        const prepared = await client.preparePhotoWorkSource(attempt.id, { sourceId: result.id, sourceVersion: result.version, physicalPage: 1 });
        if (prepared.state === "ready") update({ fields: { workSourceId: prepared.workSource.id, workSourceVersion: prepared.workSource.version, workPhysicalPage: prepared.workSource.physicalPage } });
        photo = { enabled: true, status: prepared.state, name: file.name, workSource: prepared.workSource, message: prepared.state === "pending" ? "照片已保存，解析仍在进行。" : prepared.state === "unavailable" ? "照片暂不可用于本题，文字作答仍可继续。" : undefined };
      } catch (reason) {
        photo = { enabled: true, status: "unavailable", name: file.name, message: reason instanceof Error ? reason.message : "照片当前不可用，文字作答仍可继续。" };
      }
      return refresh();
    },
    removePhoto() { if (draft().submission) throw new Error("原答案已封存，不能移除照片附件。"); update({ fields: { workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 } }); photo = { enabled: options.photoEnabled === true, status: "none" }; return refresh(); },
    async help() {
      const level = (Math.max(0, ...levels) + 1) as SpanHintLevel;
      if (!view.help.canRequest) return view;
      const hint = await requestSpanHint(attempt, level); levels = [...levels, level]; texts = [...texts, hint.text]; assistance = level === 4 ? "revealed" : "hinted";
      update({ fields: { assistance, deliveredAssistance: assistance } }); await acknowledgeStudyExposure(hint.exposureReceipt); return refresh();
    },
    async pause() { if (!await save(session.intent, session.moveId, "paused")) throw new Error("暂停尚未保存。"); },
    navigate(action) { window.location.assign(action); },
  };
}
function encodeAnswer(answer: Record<string, string>, previous: string) {
  const vector = (key: string) => (answer[key] ?? "").split(/[,，]/).map(value => value.trim()).filter(Boolean);
  return JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), recognition: "confirmed", membership: answer.membership, equation: { vectors: [vector("v"), vector("w")], target: vector("u") }, coefficients: [answer.alpha ?? "", answer.beta ?? ""], coordinateChecks: vector("checks"), representations: { system: answer.system, geometry: answer.geometry }, ...(answer.witness ? { noSolutionWitness: vector("witness") } : {}), explanation: answer.explanation ?? "" });
}
function decodeAnswer(raw: string): Record<string, string> {
  if (!raw) return {};
  const answer = JSON.parse(raw);
  return { v: answer.equation?.vectors[0]?.join(", ") ?? "", w: answer.equation?.vectors[1]?.join(", ") ?? "", u: answer.equation?.target?.join(", ") ?? "", alpha: answer.coefficients?.[0] ?? "", beta: answer.coefficients?.[1] ?? "", checks: answer.coordinateChecks?.join(", ") ?? "", membership: answer.membership ?? "", system: answer.representations?.system ?? "", geometry: answer.representations?.geometry ?? "", witness: answer.noSolutionWitness?.join(", ") ?? "", explanation: answer.explanation ?? "" };
}
