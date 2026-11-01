/**
 * span adapter for the v2 study session. It owns every span API shape and durable request identity,
 * and reuses the legacy span helpers so both UIs submit the same answer and pick the same problem.
 */
import { z } from "zod";
import { learningAttemptSchema, spanProblemSchema, type LearningAttempt, type LearningObservation, type SpanHintLevel, type SpanLessonSnapshot } from "@aistudy/contracts";
import { spanModeForIntent } from "@aistudy/domain";
import { createOpeningLearningClient } from "../../client/learning-client";
import { createOpeningApi, resolveUploadPutUrl } from "../../client/api";
import { createUploadClient } from "../../inbox/upload-client";
import { putPrivateBytes } from "../../inbox/put-private";
import { spanLessonRequest, type SpanLessonDetails } from "../../teaching/span/span-session-client";
import { nextSpanHintLevel, requestSpanHint, SPAN_HINT_LABELS } from "../../teaching/span/span-hint-client";
import { spanProblemText } from "../../teaching/span/span-problem-text";
import { isSpanReservedProblemId, readSpanDraftAnswer, SPAN_FEEDBACK_LABELS, updateSpanDraftAnswer, type SpanDraftAnswer } from "../../teaching/span/span-answer";
import { readSpanNextResult } from "../../teaching/span/span-next-action-control";
import { spanPracticeScope, spanStartsWithHint } from "../../teaching/span/span-practice";
import { spanLessonMoves, spanLessonProblemId, spanPracticeMoveId } from "../../teaching/span/span-lesson-moves";
import { spanDiagnosticNextStep } from "../../teaching/span/span-diagnostic";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
import { emptyPracticeDraft, initializePracticeDraft, patchPracticeDraft, readPracticeDraft, assertPracticeDraftSaved, switchPracticeDraft } from "../../learning/practice-draft-storage";
import { assertPracticeAttempt, readPracticeRecord } from "../../learning/practice-draft";
import type { HelpState, NextAction, PhotoState, StepResult, StudySessionPort, StudySessionView, StudyStep } from "../model";

const SKILL = "线性组合与 span";
type Move = ReturnType<typeof spanLessonMoves>[number];

type Save = (intent: SpanLessonSnapshot["intent"], move: string, status: "active" | "paused" | "completed") => Promise<boolean>;

const presentationSchema = z.object({ problem: spanProblemSchema, exposureReceipt: z.object({ id: z.string().uuid() }),
  solution: z.object({ kind: z.string(), coefficients: z.tuple([z.string(), z.string()]).optional() }) });
export function adaptSpanLearn(raw: unknown, move: Move, estimateMinutes: number | null, focus?: string): StudyStep {
  const { problem, solution } = presentationSchema.parse(raw);
  const [v, w] = problem.vectors, u = problem.target;
  const vec = (values: string[]) => `\\begin{pmatrix}${values.join("\\\\")}\\end{pmatrix}`;
  const body = [
    spanProblemText(problem).chinese,
    "span 是所有 $\\alpha v+\\beta w$ 的集合。先写出向量等式，再让每一个坐标同时成立：",
    `$$\\alpha${vec(v)}+\\beta${vec(w)}=${vec(u)}$$`,
    solution.coefficients ? `本例 $\\alpha=${solution.coefficients[0]}$，$\\beta=${solution.coefficients[1]}$。把系数代回每个坐标逐一核对。` : "",
  ].filter(Boolean).join("\n\n");
  return { kind: "learn", id: move.id, title: move.presentation.instructions, body, focus, estimateMinutes };
}

export function adaptSpanResult(record: LearningObservation, grading?: string): StepResult {
  const decision = record.serverEvaluation?.decision;
  const outcome = decision === "correct" || decision === "incorrect" ? decision
    : grading === "queued" || grading === "grading" ? "pending" : grading === "needs_manual" ? "needs_manual" : "unknown";
  const reason = record.serverEvaluation?.reasonCodes[0];
  return { outcome, assistance: record.assistance, detail: reason ? SPAN_FEEDBACK_LABELS[reason] : undefined };
}

export function adaptSpanDiagnosticResult(record: LearningObservation, attempt: LearningAttempt): StepResult {
  return { ...adaptSpanResult(record), nextStep: spanDiagnosticNextStep(record, attempt) ?? undefined };
}

/** Hints shown are only those the server already released; the next level follows the legacy ladder. */
export function adaptSpanHelp(level: HelpState["level"], hints: { level: SpanHintLevel; text: string }[], answered: boolean, sealed: boolean): HelpState {
  const next = nextSpanHintLevel(hints);
  const blockedReason = next === 4 && !answered ? "先提交自己的答案，再看完整示范。" : sealed && !answered ? "先确认原答案已保存，再继续看提示。" : undefined;
  return {
    level,
    hints: hints.map(hint => ({ level: hint.level, label: SPAN_HINT_LABELS[hint.level], text: hint.text })),
    next: next && !blockedReason ? { level: next, label: SPAN_HINT_LABELS[next] } : null,
    blockedReason,
  };
}

export function adaptSpanNext(raw: unknown, courseId: string): NextAction {
  const next = readSpanNextResult(raw, courseId);
  return next.kind === "ready" ? { href: next.href, label: next.label, alternatives: [] }
    : { href: next.primary.href, label: next.primary.label, reason: next.message, alternatives: next.secondary ? [next.secondary] : [] };
}

function strongest(...levels: (HelpState["level"] | undefined)[]): HelpState["level"] {
  return levels.includes("revealed") ? "revealed" : levels.includes("hinted") ? "hinted" : "none";
}

export function createSpanStudySession(details: SpanLessonDetails, save: Save, options: { photoEnabled?: boolean } = {}): StudySessionPort {
  const session = details.session!;
  const sourceId = session.sourceIds[0];
  const mode = spanModeForIntent(session.intent);
  const moves = spanLessonMoves(mode);
  const retestId = session.retestId ? details.continuityRetestId ?? session.retestId : undefined;
  const index = session.retestId ? moves.length - 1 : moves.findIndex(move => move.id === session.moveId);
  const move = moves[index];
  const problemId = move && index > 0 ? spanLessonProblemId(mode, index, moves.length) : null;
  const position = { index: Math.max(0, index), total: moves.length };
  const client = createOpeningLearningClient();
  const scope = spanPracticeScope(session.courseId, retestId, undefined, session.activityId, problemId ?? undefined);
  const storage = () => window.sessionStorage;
  const draft = () => readPracticeDraft(scope, storage());
  const update = (change: Parameters<typeof patchPracticeDraft>[2]) => {
    const next = patchPracticeDraft(scope, {}, change, storage()).draft; assertPracticeDraftSaved(scope); return next;
  };

  let view: StudySessionView;
  let attempt: LearningAttempt | null = null;
  let record: LearningObservation | null = null;
  let hints: { level: SpanHintLevel; text: string }[] = [];
  let delivered: HelpState["level"] = "none";
  let photo: PhotoState | null = options.photoEnabled ? { status: "none" } : null;
  const variantOrigin = () => draft()?.start?.clientKey.startsWith("span-variant:") ? draft()!.start!.clientKey.slice("span-variant:".length) : null;
  const correctedRedo = () => Boolean(record && attempt && adaptSpanResult(record).outcome === "correct"
    && session.intent.purpose === "self_study" && !retestId && !variantOrigin()
    && (draft()?.start?.clientKey.startsWith("span-redo:") || details.attempts.some(row => row.id !== attempt!.id
      && row.itemVersionId === attempt!.itemVersionId && details.observations.some(observation => observation.attemptId === row.id && observation.serverEvaluation?.decision === "incorrect"))));

  const blockedView = (step: StudyStep, blocked: string): StudySessionView =>
    ({ step, position, help: adaptSpanHelp("none", [], false, false), answer: {}, sealed: false, blocked, result: null, next: null, photo: null });
  function refresh(next: NextAction | null = view?.next ?? null): StudySessionView {
    const current = draft();
    const sealed = Boolean(current?.submission);
    const help = retestId && !record ? { level: delivered, hints: [], next: null } : adaptSpanHelp(delivered, hints, Boolean(record), sealed);
    view = { ...view, help, answer: readSpanDraftAnswer(current?.fields.answer ?? ""),
      sealed, result: record ? (attempt ? adaptSpanDiagnosticResult(record, attempt) : adaptSpanResult(record)) : null, next, photo,
      canPracticeVariant: correctedRedo(),
      canRedo: Boolean(record && adaptSpanResult(record).outcome !== "correct" && !retestId && !photo?.workSource
        && !current?.submission?.input.workSource && !current?.start?.clientKey.startsWith("span-redo:")) };
    return view;
  }

  async function loadQuestion(): Promise<StudySessionView> {
    const step: StudyStep = { kind: "question", id: session.activityId, title: SKILL, prompt: "", purpose: retestId ? "retest" : "practice", estimateMinutes: details.estimateMinutes ?? null, photo: Boolean(options.photoEnabled), coordinates: 0 };
    if (!sourceId) return blockedView(step, "这节课的资料暂时不可用，请先到课程页恢复资料。");
    if (!readPracticeDraft(scope, storage())) {
      initializePracticeDraft(emptyPracticeDraft(scope, { sourceId, spanProblemId: problemId!, skillLabel: SKILL,
        assistance: !retestId && spanStartsWithHint(problemId!, session.intent, details.executionPhase ?? undefined) ? "hinted" : "independent" }));
    }
    const evidence = details.intentEvent?.signals.some(signal => signal === "guessed" || signal === "copied_answer") ? details.intentEvent : null;
    const restored = [...details.attempts]
      .filter(row => !evidence || !isSpanReservedProblemId(row.spanExercise?.id) || row.startedAt >= evidence.createdAt)
      .sort((a, b) => b.historyRevision - a.historyRevision || b.startedAt.localeCompare(a.startedAt))
      .find(row => problemId === "reserved:auto" ? isSpanReservedProblemId(row.spanExercise?.id) : row.spanExercise?.id === problemId);
    const known = draft()!.attemptId;
    const issuedVariant = restored && !known && !draft()?.start ? restored.spanPracticeOriginAttemptId ? restored : details.attempts
      .filter(row => row.sessionId === session.sessionId && row.spanPracticeOriginAttemptId === restored.id)
      .sort((a, b) => b.historyRevision - a.historyRevision)[0] : undefined;
    if (issuedVariant) update({ start: { clientKey: `span-variant:${issuedVariant.spanPracticeOriginAttemptId}`, sessionId: session.sessionId,
      sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [sourceId], skillLabel: SKILL }, createInput: null } });
    let created = false;
    if (known) attempt = (await client.getAttemptContext(known)).attempt;
    else if (issuedVariant) attempt = issuedVariant;
    else if (restored && !draft()?.start?.clientKey.startsWith("span-redo:") && !variantOrigin()) attempt = restored;
    else {
      created = true;
      const start = update(current => ({ start: current.start ?? { clientKey: `span-start:${crypto.randomUUID()}`, sessionId: session.sessionId,
        sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [sourceId], skillLabel: SKILL }, createInput: null } })).start!;
      if (!start.clientKey.startsWith("span-redo:") && !variantOrigin()) await spanLessonRequest("/api/opening/teaching/span/session", z.unknown(), { method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId, intent: session.intent, clientKey: start.clientKey, moveId: spanPracticeMoveId(session.intent.purpose, problemId!), ...(session.retestId ? { retestId: session.retestId } : {}) }) });
      attempt = variantOrigin()
        ? await spanLessonRequest("/api/opening/teaching/span/reserved", learningAttemptSchema, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, sourceId, clientKey: start.clientKey, mode, afterAttemptId: variantOrigin() }) })
        : start.clientKey.startsWith("span-redo:") ? await client.createAttempt(start.createInput!) : problemId === "reserved:auto"
        ? await spanLessonRequest("/api/opening/teaching/span/reserved", learningAttemptSchema, { method: "POST", body: JSON.stringify({ sessionId: session.sessionId, sourceId, clientKey: start.clientKey, mode }) })
        : await client.createAttempt({ sessionId: session.sessionId, clientKey: start.clientKey, spanExercise: { sourceId, problemId: problemId!, version: 1 } });
    }
    const current = attempt;
    if (current.courseId !== session.courseId || current.sessionId !== session.sessionId || !current.spanExercise) throw new Error("原题身份已变化，请重新读取。");
    if (known) assertPracticeAttempt(draft()!, current);
    const attemptSource = current.contextAnchor?.sourceId ?? current.sourceIds[0];
    if (!attemptSource || !current.sourceIds.includes(attemptSource)) throw new Error("原题关联资料暂时无法核实。");
    update(previous => ({ attemptId: current.id,
      start: previous.start?.createInput ? previous.start : { clientKey: previous.start?.clientKey ?? `span-restored:${current.id}`, sessionId: session.sessionId,
        sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [attemptSource], skillLabel: SKILL },
        createInput: { sessionId: session.sessionId, clientKey: previous.start?.clientKey ?? `span-restored:${current.id}`,
          spanExercise: { sourceId: attemptSource, problemId: current.spanExercise!.id, version: Number(current.spanExercise!.version) } } },
      fields: { spanProblemId: current.spanExercise!.id, spanVersion: Number(current.spanExercise!.version), sourceId: attemptSource } }));

    const state = await readPracticeRecord(client, session.courseId, current, draft()!.observationId);
    record = state.observation;
    if (record?.answer && !draft()!.fields.answer) update({ fields: { answer: record.answer } });
    // Only replay levels the server already released for this attempt (legacy rule). Faded examples
    // open with hint 1 unless the learner is consolidating.
    const levels = [...new Set(details.hintLevels[current.id] ?? [])].sort();
    if (created && !variantOrigin() && !draft()!.start?.clientKey.startsWith("span-redo:") && !retestId && spanStartsWithHint(current.spanExercise.id, session.intent, details.executionPhase ?? undefined)) levels.push(1);
    // Re-reading a released level is idempotent on the server (same release key), so this never adds help.
    hints = await Promise.all((retestId && !record ? [] : levels).map(async level => {
      const hint = await requestSpanHint(current, level);
      void acknowledgeStudyExposure(hint.exposureReceipt).catch(() => undefined);
      return { level, text: hint.text };
    }));
    delivered = strongest(state.deliveredAssistance, details.assistance[current.id], draft()!.fields.deliveredAssistance,
      draft()!.fields.assistance === "revealed" ? "revealed" : draft()!.fields.assistance === "hinted" ? "hinted" : "none",
      levels.includes(4) ? "revealed" : levels.length ? "hinted" : "none");
    if (created && hints.length) update({ fields: { deliveredAssistance: delivered, assistance: delivered === "none" ? "independent" : delivered } });

    const saved = draft()!.fields;
    if (photo && saved.workSourceId) {
      const candidate = { id: saved.workSourceId, version: saved.workSourceVersion, physicalPage: saved.workPhysicalPage };
      photo = await checkPhoto(current, candidate, "作答照片");
    }
    const prompt = spanProblemText(current.spanExercise).chinese;
    view = { step: { ...step, id: current.id, prompt, coordinates: current.spanExercise.target.length },
      position, help: adaptSpanHelp(delivered, hints, Boolean(record), false), answer: {}, sealed: false, result: null, next: null, photo };
    return refresh(null);
  }

  async function checkPhoto(current: LearningAttempt, candidate: { id: string; version: number; physicalPage: number }, name: string): Promise<PhotoState> {
    try {
      const checked = await client.preparePhotoWorkSource(current.id, { sourceId: candidate.id, sourceVersion: candidate.version, physicalPage: candidate.physicalPage });
      if (checked.state === "ready") update({ fields: { workSourceId: checked.workSource.id, workSourceVersion: checked.workSource.version, workPhysicalPage: checked.workSource.physicalPage } });
      return { status: checked.state, name, workSource: checked.workSource,
        message: checked.state === "pending" ? "照片已保存，还在读取。" : checked.state === "unavailable" ? "这张照片暂时不能用于本题，可以改用文字作答。" : undefined };
    } catch (reason) {
      return { status: "unavailable", name, workSource: candidate, message: reason instanceof Error ? reason.message : "照片暂时无法核实，可以改用文字作答。" };
    }
  }

  return {
    async load() {
      if (!move) return blockedView({ kind: "learn", id: session.moveId, title: SKILL, body: "", estimateMinutes: null }, "学习位置已变化，请重新读取本节。");
      if (index === 0) {
        if (!sourceId) return blockedView({ kind: "learn", id: move.id, title: SKILL, body: "", estimateMinutes: null }, "这节课的资料暂时不可用，请先到课程页恢复资料。");
        const kind = mode === "overview" ? "overview" : mode === "challenge" ? "simulation" : "worked";
        const raw = await spanLessonRequest("/api/opening/teaching/span/presentation", presentationSchema, { method: "POST",
          body: JSON.stringify({ courseId: session.courseId, sourceId, sessionId: session.sessionId, kind, clientKey: `span-demo:${session.sessionId}:${sourceId}:${kind}:v1` }) });
        await acknowledgeStudyExposure(raw.exposureReceipt);
        view = { step: adaptSpanLearn(raw, move, details.estimateMinutes ?? null, details.targetedFocus), position,
          help: adaptSpanHelp("none", [], false, false), answer: {}, sealed: false, result: null, next: null, photo: null };
        return view;
      }
      return loadQuestion();
    },
    edit(change: Partial<SpanDraftAnswer>) {
      const current = draft();
      if (!current || view.step.kind !== "question") return view;
      if (current.submission) throw new Error("答案已提交，不能再修改。");
      update({ fields: { answer: updateSpanDraftAnswer(current.fields.answer, change) } });
      return refresh();
    },
    async redo() {
      if (draft()?.start?.clientKey.startsWith("span-redo:") && !draft()?.attemptId) return loadQuestion();
      if (!view.canRedo || !record || !attempt?.spanExercise) return view;
      const previous = draft()!;
      const clientKey = `span-redo:${crypto.randomUUID()}`;
      const next = emptyPracticeDraft(scope, { ...previous.fields, answer: record.answer,
        assistance: delivered === "revealed" ? "revealed" : "hinted",
        deliveredAssistance: delivered === "revealed" ? "revealed" : "hinted" });
      next.start = { clientKey, sessionId: session.sessionId, sessionInput: previous.start!.sessionInput,
        createInput: { sessionId: session.sessionId, clientKey, spanExercise: { sourceId: previous.fields.sourceId,
          problemId: attempt.spanExercise.id, version: Number(attempt.spanExercise.version) } } };
      switchPracticeDraft(scope, previous.id, next, storage());
      return loadQuestion();
    },
    async primary() {
      if (view.blocked) return view;
      if (variantOrigin() && !draft()?.attemptId) return loadQuestion();
      if (view.step.kind === "learn") {
        if (!await save(session.intent, moves[index + 1]!.id, "active")) throw new Error("学习进度还没保存，请再试一次。");
        return view;
      }
      // Navigation to the successor belongs to the shell (router + transition), not the adapter.
      if (view.next) return view;
      const current = attempt!;
      if (record) {
        if (correctedRedo()) {
          const previous = draft()!;
          const next = emptyPracticeDraft(scope, { sourceId, spanProblemId: problemId!, skillLabel: SKILL, assistance: "independent" });
          next.start = { clientKey: `span-variant:${current.id}`, sessionId: session.sessionId,
            sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: [sourceId], skillLabel: SKILL }, createInput: null };
          switchPracticeDraft(scope, previous.id, next, storage());
          photo = options.photoEnabled ? { status: "none" } : null;
          return loadQuestion();
        }
        // Ordinary self-study advances within this lesson via its existing progress owner.
        // Adaptive follow-up (including the final/reserved step and retests) keeps /next admission.
        const nextMove = moves[index + 1];
        if (session.intent.purpose === "self_study" && !retestId && nextMove) {
          if (!await save(session.intent, nextMove.id, "active")) throw new Error("学习进度还没保存，请再试一次。");
          return view;
        }
        const raw = await spanLessonRequest("/api/opening/teaching/span/next", z.unknown(), { method: "POST", body: JSON.stringify({ activityId: session.activityId,
          expectedRevision: session.revision, observationId: record.id, clientKey: `span-next:${session.activityId}:${session.revision}:${record.id}` }) });
        return refresh(adaptSpanNext(raw, session.courseId));
      }
      // Replay a sealed request first; only a fresh submission reads the current photo candidate.
      const sealed = draft()!.submission;
      const readyPhoto = photo?.status === "ready" && photo.workSource ? photo.workSource : null;
      if (!sealed && photo && photo.status !== "none" && !readyPhoto) throw new Error("照片还没准备好。可以移除照片后用文字作答，或重新选择照片。");
      const submission = sealed ?? update(previous => ({ submission: { attemptId: current.id, input: {
        clientKey: `span-first-answer:${crypto.randomUUID()}`, answer: previous.fields.answer, ...(retestId ? { retestId } : {}),
        assistance: delivered === "none" ? "independent" : delivered, outcome: "unverified", verdictSource: "self_report",
        ...(readyPhoto ? { workSource: readyPhoto } : {}) } } })).submission!;
      const saved = await client.submitAttempt(current.id, submission.input);
      update({ observationId: saved.id });
      record = (await readPracticeRecord(client, session.courseId, current, saved.id)).observation;
      if (!record) throw new Error("结果还没读到，答案已保留，请重新读取。");
      return refresh(null);
    },
    async help() {
      const current = attempt;
      if (!current || !view.help.next) return view;
      const level = view.help.next.level as SpanHintLevel;
      const hint = await requestSpanHint(current, level);
      await acknowledgeStudyExposure(hint.exposureReceipt);
      hints = [...hints, { level, text: hint.text }];
      delivered = strongest(delivered, level === 4 ? "revealed" : "hinted");
      update({ fields: { deliveredAssistance: delivered, assistance: delivered === "none" ? "independent" : delivered } });
      return refresh();
    },
    async choosePhoto(file: File) {
      const current = attempt;
      if (!photo || !current) return view;
      if (draft()?.submission) throw new Error("答案已提交，不能更换照片。");
      // Detach the old candidate before any remote work, so a failed replacement never submits the old photo.
      update({ fields: { workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 } });
      photo = { status: "uploading", name: file.name };
      const api = createOpeningApi();
      const upload = createUploadClient({ begin: input => api.beginUpload(input), complete: id => api.completeUpload(id),
        put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, loaded => onProgress(loaded)), resolvePutUrl: resolveUploadPutUrl, refreshTicket: id => api.refreshUploadTicket(id) });
      try {
        const result = await upload.uploadFile({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
        if ("phase" in result) { photo = { status: "failed", name: file.name, message: result.message }; return refresh(); }
        // The photo stays a private upload; it is attached to this answer only, never to the course materials.
        update({ fields: { workSourceId: result.id, workSourceVersion: result.version, workPhysicalPage: 1 } });
        photo = await checkPhoto(current, { id: result.id, version: result.version, physicalPage: 1 }, file.name);
      } catch (reason) {
        photo = { status: "unavailable", name: file.name, message: reason instanceof Error ? reason.message : "照片暂时不能用，可以改用文字作答。" };
      }
      return refresh();
    },
    removePhoto() {
      if (draft()?.submission) throw new Error("答案已提交，不能移除照片。");
      update({ fields: { workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 } });
      photo = options.photoEnabled ? { status: "none" } : null;
      return refresh();
    },
    async pause() {
      if (!await save(session.intent, session.moveId, "paused")) throw new Error("暂停还没保存，请再试一次。");
    },
  };
}
