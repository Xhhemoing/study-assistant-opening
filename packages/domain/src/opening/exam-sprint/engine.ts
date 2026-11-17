import type {
  ExamAttempt, ExamAttemptView, ExamExposureCoverage, ExamMode, ExamPack, ExamQuestion, ExamRun,
  ExamSkillSummary, ExamSourceRecord, ExamSprintCommand, ExamSprintOverview, ExamSprintState,
} from "@aistudy/contracts";
import { examQuestionPartsSchema, questionEvaluationSchema, type QuestionEvaluation, type QuestionPartAssistance } from "@aistudy/contracts";
import { validExamLessonExposure } from "./lesson-exposure-mapping";

/** Only called with a server-resolved immutable question; shape alone never grants authority. */
export function evaluateExamQuestionParts(question: ExamQuestion, pack: Pick<ExamPack, "id" | "version">,
  answer: string, evaluationRefId: string, assistance: QuestionPartAssistance): QuestionEvaluation | null {
  if (!question.partSnapshot) return null;
  const snapshot = examQuestionPartsSchema.parse(question.partSnapshot);
  if (snapshot.packId !== pack.id || snapshot.packVersion !== pack.version || snapshot.questionId !== question.id
    || snapshot.familyId !== question.familyId) throw new Error("Part snapshot question revision mismatch");
  const optionIds = new Set(question.options.map(option => option.id));
  return questionEvaluationSchema.parse({ protocolVersion: "question-evaluation-1", evaluationRefId,
    questionIdentityRefId: snapshot.questionIdentityRefId, parts: snapshot.parts.map(part => {
      const valid = part.evaluator && part.evaluator.correctOptionIds.every(id => optionIds.has(id)) && optionIds.has(answer);
      return { partId: part.partId, identityRefId: part.identityRefId, requirementKey: part.requirementKey,
        outcome: valid ? part.evaluator!.correctOptionIds.includes(answer) ? "correct" : "incorrect" : "unknown",
        assistance: valid ? assistance : "unknown" };
    }) });
}
import { snapshotExamPrediction } from "./analytics";
import { captureExamAttemptExposures, examAttemptExposureQualification } from "./exposure-qualification";
export { examAttemptExposureQualification } from "./exposure-qualification";
export { validExamLessonExposure } from "./lesson-exposure-mapping";

export type ExamRuleEvidence = { usable: boolean; correct: boolean | null; independent: boolean; assisted: boolean };
export type ExamSelectionContext = {
  /** Server-classified real source provenance; never inferred from an empty ledger. */
  exposureCoverage?: ExamExposureCoverage;
  bktEligibleAttemptIds?: readonly string[];
  /** Live canonical qualification for linked records; absent keys retain isolated sprint history. */
  ruleEvidence?: Readonly<Record<string, ExamRuleEvidence>>;
  /** Ranked learning recommendations require an attributable current source record. */
  sourceRecordEligibility?: Readonly<Record<string, boolean>>;
  /** Unknown formal mapping does not invalidate the learner's reported work. */
  sourceCoverageEligibility?: Readonly<Record<string, boolean>>;
};

const DAY = 24 * 60 * 60 * 1000;
const isMock = (mode: ExamMode) => mode === "mock-a" || mode === "mock-b";
const at = (value: string) => Date.parse(value);

function fail(code: "VALIDATION" | "CONFLICT" | "NOT_FOUND", message: string): never {
  throw Object.assign(new Error(message), { code });
}

function questionFor(pack: ExamPack, id: string): ExamQuestion {
  return pack.questions.find(question => question.id === id) ?? fail("NOT_FOUND", "题目不存在，请重新载入题包。");
}

function activeRun(state: ExamSprintState): ExamRun | null {
  return state.runs.find(run => run.completedAt === null) ?? null;
}

function currentAttempt(state: ExamSprintState, run: ExamRun): ExamAttempt | null {
  return state.attempts.filter(attempt => attempt.runId === run.id).at(-1) ?? null;
}

function independent(attempt: ExamAttempt, state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): boolean {
  const exposure = examAttemptExposureQualification(attempt, state, pack);
  if (attempt.answeredAt === null || attempt.help.length > 0 || exposure.exposureHistoryUncertain || exposure.lessonAssistance !== false || exposure.firstFamilyExposure !== true) return false;
  const current = context?.ruleEvidence?.[attempt.id];
  if (current && (!current.usable || !current.independent || current.assisted)) return false;
  return true;
}

function assisted(attempt: ExamAttempt, state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): boolean {
  return Boolean(attempt.lessonExposureIds?.length) || examAttemptExposureQualification(attempt, state, pack).partialExample === true
    || attempt.help.length > 0 || context?.ruleEvidence?.[attempt.id]?.assisted === true;
}

function visibleEvidence(state: ExamSprintState, context?: ExamSelectionContext): ExamAttempt[] {
  const sealedRuns = new Set(state.runs.filter(run => isMock(run.mode) && !run.completedAt).map(run => run.id));
  return state.attempts.filter(attempt => attempt.answeredAt !== null && !sealedRuns.has(attempt.runId) && context?.ruleEvidence?.[attempt.id]?.usable !== false)
    .map(attempt => {
      const current = context?.ruleEvidence?.[attempt.id];
      if (!current) return attempt;
      // Preserve the captured first answer. A later correction can remove its success,
      // but cannot manufacture a new independent success or erase a real first failure.
      const correct = attempt.correct === false || current.correct === false ? false
        : attempt.correct === true && current.correct === true ? true : null;
      return { ...attempt, correct };
    });
}

function recheckSkills(state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): Set<string> {
  const sealedRuns = new Set(state.runs.filter(run => isMock(run.mode) && !run.completedAt).map(run => run.id));
  return new Set(state.attempts.filter(attempt => {
    const current = context?.ruleEvidence?.[attempt.id];
    return attempt.answeredAt !== null && current && !sealedRuns.has(attempt.runId) && (!current.usable
      || attempt.correct === true && (!current.independent || current.correct !== true));
  }).map(attempt => questionFor(pack, attempt.questionId).skillId));
}

function skillSummaries(state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): ExamSkillSummary[] {
  const evidence = visibleEvidence(state, context);
  const recheck = recheckSkills(state, pack, context);
  const skills = [...new Map(pack.questions.map(question => [question.skillId, question])).values()];
  return skills.map(question => {
    const attempts = evidence.filter(attempt => questionFor(pack, attempt.questionId).skillId === question.skillId);
    const wins = attempts.filter(attempt => attempt.correct === true && independent(attempt, state, pack, context));
    const effective = attempts.filter(attempt => attempt.correct === false || assisted(attempt, state, pack, context) || independent(attempt, state, pack, context));
    const last = effective.at(-1);
    const failureIndex = effective.reduce((latest, attempt, index) => attempt.correct === false || assisted(attempt, state, pack, context) ? index : latest, -1);
    const recoveredWins = effective.slice(failureIndex + 1).filter(attempt => attempt.correct === true && independent(attempt, state, pack, context));
    const firstWin = recoveredWins[0];
    const lastWin = recoveredWins.at(-1);
    const secure = firstWin?.answeredAt && lastWin?.answeredAt && recoveredWins.length >= 2
      && at(lastWin.answeredAt) - at(firstWin.answeredAt) >= DAY;
    const weak = last && (last.correct === false || assisted(last, state, pack, context));
    const status = weak ? "weak" : secure ? "secure" : wins.length > 0 ? "usable" : "untested";
    const latestTime = last?.answeredAt ?? last?.help.at(-1)?.at;
    return {
      skillId: question.skillId, topicId: question.topicId,
      title: pack.lessons.find(lesson => lesson.id === question.lessonId)?.title ?? question.skillId,
      status, independentCorrect: wins.length, attempted: attempts.filter(attempt => attempt.answeredAt !== null).length,
      dueAt: latestTime && status !== "secure" ? new Date(at(latestTime) + DAY).toISOString() : null,
      reason: (status === "weak" ? "最近有效证据为答错或求助；至少间隔 24 小时后用未见变式复测。"
        : status === "secure" ? "至少两个未见题族独立答对，且成功证据间隔至少 24 小时。"
          : status === "usable" ? "已有未见题族独立正确证据；还需不同题族的隔日独立成功。"
            : "尚无未见题族的独立成功证据；看解析或重复答对不提升掌握等级。")
        + (recheck.has(question.skillId) ? "部分原始记录状态已修订、撤回或暂不可用；历史答案保留，但不再作为当前掌握证明。" : ""),
      lessonId: question.lessonId,
    };
  });
}

function currentSourceRecords(state: ExamSprintState, context?: ExamSelectionContext, purpose: "coverage" | "ranking" = "coverage"): ExamSourceRecord[] {
  const eligibility = purpose === "ranking" ? context?.sourceRecordEligibility : context?.sourceCoverageEligibility;
  return state.sourceRecords.filter(record => eligibility?.[record.id] !== false);
}

function sourcePrioritySkills(state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): Set<string> {
  const latest = new Map<string, ExamSourceRecord>();
  for (const record of currentSourceRecords(state, context, "ranking")) latest.set(record.sourceId, record);
  const skills = new Set<string>();
  for (const record of latest.values()) {
    if (record.outcome !== "incorrect" && record.outcome !== "partial" && record.assistance === "none") continue;
    for (const skill of pack.sourceItems.find(source => source.id === record.sourceId)?.skills ?? []) skills.add(skill);
  }
  return skills;
}

function rankedQuestions(questions: ExamQuestion[], state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): ExamQuestion[] {
  const seen = new Set(state.attempts.map(attempt => attempt.questionId));
  const families = new Set(state.attempts.map(attempt => questionFor(pack, attempt.questionId).familyId));
  const summaries = skillSummaries(state, pack, context);
  const weak = new Set(summaries.filter(skill => skill.status === "weak").map(skill => skill.skillId));
  const recheck = recheckSkills(state, pack, context);
  const currentRecheck = new Set(summaries.filter(skill => skill.status !== "secure" && recheck.has(skill.skillId)).map(skill => skill.skillId));
  const causes = new Set(visibleEvidence(state, context).filter(attempt => attempt.errorCause !== null)
    .map(attempt => questionFor(pack, attempt.questionId).skillId));
  const sourcePriorities = sourcePrioritySkills(state, pack, context);
  const score = (question: ExamQuestion) => (seen.has(question.id) ? 8 : 0)
    + (families.has(question.familyId) ? 4 : 0) + (weak.has(question.skillId) && causes.has(question.skillId) ? 0 : 2)
    - (sourcePriorities.has(question.skillId) || currentRecheck.has(question.skillId) ? 1 : 0);
  return [...questions].sort((left, right) => score(left) - score(right));
}

function practicePriorities(state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): Map<string, number> {
  const recheck = recheckSkills(state, pack, context);
  const source = sourcePrioritySkills(state, pack, context);
  const latest = new Map(visibleEvidence(state, context).map(attempt => [questionFor(pack, attempt.questionId).skillId, attempt]));
  return new Map(skillSummaries(state, pack, context).map(skill => {
    const confidence = latest.get(skill.skillId)?.confidence;
    const urgent = skill.status === "weak" || skill.status !== "secure" && recheck.has(skill.skillId) || source.has(skill.skillId)
      || confidence !== null && confidence !== undefined && confidence <= 2;
    return [skill.skillId, urgent ? 0 : skill.status === "untested" ? 1 : skill.status === "usable" ? 2 : 3];
  }));
}

function practiceFamilies(state: ExamSprintState, pack: ExamPack): Set<string> {
  const families = new Set(state.attempts.map(attempt => questionFor(pack, attempt.questionId).familyId));
  for (const exposure of state.lessonExposures ?? []) {
    if (exposure.packId !== pack.id) continue;
    for (const familyId of [...exposure.displayedFamilyIds, ...(exposure.partialFamilyIds ?? [])]) families.add(familyId);
  }
  return families;
}

function practiceQuestions(state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): ExamQuestion[] {
  const seen = new Set(state.attempts.map(attempt => attempt.questionId));
  const families = practiceFamilies(state, pack);
  const priorities = practicePriorities(state, pack, context);
  // Allocation is only a rotation hint. Unpresented questions remain fresh evidence.
  const scheduled = new Map<string, number>();
  state.runs.forEach((run, index) => {
    if (run.mode === "practice") run.questionIds.forEach(id => scheduled.set(id, index));
  });
  return pack.questions.filter(question => question.pool === "training" && !seen.has(question.id)).sort((left, right) =>
    priorities.get(left.skillId)! - priorities.get(right.skillId)!
    || Number(families.has(left.familyId)) - Number(families.has(right.familyId))
    || (scheduled.get(left.id) ?? -1) - (scheduled.get(right.id) ?? -1));
}

function practiceExposureNote(questions: ExamQuestion[], state: ExamSprintState, pack: ExamPack): string {
  const families = practiceFamilies(state, pack);
  return questions.some(question => families.has(question.familyId))
    ? "含已见题族或串讲例题的变式，不计独立新证据。" : "";
}

function activePracticeNote(run: ExamRun, state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): string {
  const questions = run.questionIds.map(id => questionFor(pack, id));
  const foundation = questions.filter(question => question.difficulty === "foundation").length;
  const chapters = [...new Set(questions.map(question => question.topicId))]
    .map(id => pack.topics.find(topic => topic.id === id)?.title ?? id);
  const presented = new Map(state.attempts.filter(attempt => attempt.runId === run.id).map(attempt => [attempt.questionId, attempt]));
  const families = practiceFamilies({ ...state, attempts: state.attempts.filter(attempt => attempt.runId !== run.id) }, pack);
  let variants = false;
  for (const question of questions) {
    const attempt = presented.get(question.id);
    const exposure = attempt ? examAttemptExposureQualification(attempt, state, pack) : null;
    variants ||= exposure ? exposure.firstFamilyExposure === false || exposure.seenExample === true || exposure.partialExample === true
      : families.has(question.familyId);
    families.add(question.familyId);
  }
  const arrangedSkills = new Set(questions.map(question => question.skillId));
  const missingWeak = [...practicePriorities(state, pack, context)].some(([skillId, priority]) => priority === 0 && !arrangedSkills.has(skillId));
  return `本轮共 ${questions.length} 题：基础 ${foundation} 题、迁移 ${questions.length - foundation} 题。章节：${chapters.join("、")}。`
    + (questions.length < 3 ? "本轮不足 3 题，可继续串讲、做原题或练习其他章节。" : "")
    + (variants ? "安排含同类变式。" : "")
    + (missingWeak ? "本轮未安排部分薄弱或低信心知识点，可先串讲或做原题。" : "");
}
function selectTopicPracticeQuestions(state: ExamSprintState, pack: ExamPack, topicId: string, context?: ExamSelectionContext) {
  const candidates = practiceQuestions(state, pack, context).filter(question => question.topicId === topicId);
  const priorities = practicePriorities(state, pack, context);
  const families = practiceFamilies(state, pack);
  const scheduled = new Map<string, number>();
  state.runs.forEach((run, index) => {
    if (run.mode === "practice") run.questionIds.forEach(id => scheduled.set(id, index));
  });
  const picked: ExamQuestion[] = [];
  while (picked.length < 3 && candidates.length) {
    candidates.sort((left, right) => priorities.get(left.skillId)! - priorities.get(right.skillId)!
      || Number(families.has(left.familyId)) - Number(families.has(right.familyId))
      || (scheduled.get(left.id) ?? -1) - (scheduled.get(right.id) ?? -1));
    const selected = candidates.shift()!;
    picked.push(selected);
    families.add(selected.familyId);
  }
  return { ids: picked.map(question => question.id), note: picked.length
    ? `本轮共 ${picked.length} 题。` + (picked.length < 3 ? "本章新题不足，已缩短本轮；可串讲、做原题或练习其他章节。" : "") + practiceExposureNote(picked, state, pack)
    : "本章没有新的针对题；请先串讲、做原题或练习其他章节，不自动重复旧题。" };
}
function selectQuestions(state: ExamSprintState, pack: ExamPack, mode: ExamMode, now: string, context?: ExamSelectionContext): { ids: string[]; note: string } {
  if (isMock(mode)) return { ids: pack.questions.filter(question => question.pool === mode).map(question => question.id), note: "专用保留题池，交卷后统一反馈。" };
  const questions = rankedQuestions(pack.questions.filter(question => question.pool === "training"), state, pack, context);
  if (mode === "diagnostic") {
    const chosen = pack.topics.flatMap(topic => {
      const candidates = questions.filter(question => question.topicId === topic.id);
      const first = candidates.find(question => question.difficulty === "foundation") ?? candidates[0];
      const second = candidates.find(question => question.familyId !== first?.familyId && question.skillId !== first?.skillId)
        ?? candidates.find(question => question.familyId !== first?.familyId);
      return [first, second].filter((question): question is ExamQuestion => Boolean(question));
    });
    return { ids: chosen.map(question => question.id), note: "每章抽取 1–2 题；小样本诊断只用于安排练习。" };
  }
  const skills = skillSummaries(state, pack, context);
  if (mode === "retest") {
    const due = skills.filter(skill => (skill.status === "weak" || skill.status === "usable") && skill.dueAt !== null && at(skill.dueAt) <= at(now));
    const seen = new Set(state.attempts.map(attempt => attempt.questionId));
    const selected = due.flatMap(skill => {
      const candidate = questions.find(question => question.skillId === skill.skillId && !seen.has(question.id));
      return candidate ? [candidate] : [];
    }).slice(0, 6);
    return { ids: selected.map(question => question.id), note: selected.length
      ? "复测已满 24 小时的薄弱或初步可用技能，优先未见题族；同题族变式不计独立新证据。"
      : due.length ? "技能已到复测时间，但训练池没有未见题；请补充不同题族，不能以重复题证明掌握。"
        : "暂无已满 24 小时的薄弱或初步可用技能，请到期后复测。" };
  }
  const recheck = recheckSkills(state, pack, context);
  const priorities = practicePriorities(state, pack, context);
  const candidates = practiceQuestions(state, pack, context);
  const picked: ExamQuestion[] = [];
  const take = (predicate: (question: ExamQuestion) => boolean, count: number) => {
    const selected = candidates.filter(question => predicate(question) && !picked.some(item => item.id === question.id)).slice(0, count);
    picked.push(...selected);
    return selected.length;
  };
  const targeted = take(question => priorities.get(question.skillId)! <= 1 && question.difficulty === "foundation", 3);
  const foundation = take(question => question.difficulty === "foundation", 6);
  const transfer = take(question => question.difficulty === "transfer", 1);
  const short = targeted < 3 || foundation < 6 || transfer < 1;
  if (picked.length < 10) take(() => true, 10 - picked.length);
  if (!picked.length) return { ids: [], note: "没有新的针对题；请先串讲、做原题或练习其他章节，不自动重复旧题。" };
  const exhaustedWeak = [...priorities].some(([skillId, priority]) => priority === 0 && !candidates.some(question => question.skillId === skillId));
  const note = `练习目标为 6 道基础、3 道薄弱或待确认、1 道迁移；本轮对应配额 ${foundation}/${targeted}/${transfer}。`
    + (short ? `新题或对应题型不足，本轮仅使用未展示训练题，共 ${picked.length} 题；不能视为完整覆盖。` : "优先薄弱、低信心与待确认技能，再补基础覆盖。")
    + (exhaustedWeak ? "部分薄弱或低信心技能已无新题，未以旧题补足；请先串讲或做原题。" : "")
    + (sourcePrioritySkills(state, pack, context).size ? "已关联的纸笔自评错误或求助仅提高相关题的练习优先级，不作为掌握证明。" : "")
    + (recheck.size ? "记录变化后尚未重新证明的技能纳入定向练习；原始题族仍算已见。" : "")
    + practiceExposureNote(picked, state, pack);
  picked.sort((left, right) => priorities.get(left.skillId)! - priorities.get(right.skillId)!);
  return { ids: picked.map(question => question.id), note };
}
function newAttempt(run: ExamRun, questionId: string, state: ExamSprintState, pack: ExamPack, clientKey: string, now: string, context?: ExamSelectionContext): ExamAttempt {
  const attempt: ExamAttempt = {
    id: `attempt-${state.attempts.length + 1}-${clientKey.slice(0, 65)}`, questionId, runId: run.id,
    presentedAt: now, answeredAt: null, answer: null, correct: null, confidence: null, durationSeconds: null,
    help: [], errorCause: null,
    prediction: snapshotExamPrediction(state, pack, questionId, now, context?.bktEligibleAttemptIds),
  };
  captureExamAttemptExposures(attempt, state, pack, context?.exposureCoverage);
  return attempt;
}

export function createExamSprintState(now: string): ExamSprintState {
  return { version: 1, startedAt: now, examDate: null, dailyMinutes: 360, runs: [], attempts: [], sourceRecords: [], lessonExposures: [] };
}

function recordSource(state: ExamSprintState, command: Extract<ExamSprintCommand, { action: "source" }>, pack: ExamPack, now: string): void {
  if (!pack.sourceItems.some(source => source.id === command.sourceId)) fail("NOT_FOUND", "原题条目不存在。");
  const previous = state.sourceRecords.filter(record => record.sourceId === command.sourceId);
  const last = previous.at(-1);
  if (last && at(now) <= at(last.recordedAt)) fail("CONFLICT", "请在完成下一次学习后再追加记录。");
  if (command.outcome !== "read" && command.durationMinutes <= 0) fail("VALIDATION", "实际作答请记录大于零的用时。");
  if (command.phase === "first" && previous.length > 0) fail("CONFLICT", "首次学习已记录，请追加盲做、隔日或变式记录。");
  if (command.phase !== "first" && !previous.some(record => record.phase === "first")) fail("CONFLICT", "请先完成首次学习记录。");
  if (command.phase === "delayed") {
    const baseline = previous.filter(record => record.phase === "blind" || record.phase === "delayed"
      || (record.phase === "first" && record.assistance === "none" && record.outcome === "correct")).at(-1);
    if (!baseline) fail("CONFLICT", "首次未能独立答对，请先完成一次盲做记录，再安排隔日复测。");
    if (at(now) - at(baseline.recordedAt) < DAY) fail("CONFLICT", "隔日复测须与上次盲做或复测间隔至少 24 小时。");
  }
  if (command.phase === "variant") {
    if (!previous.some(record => record.phase === "delayed" && record.outcome === "correct" && record.assistance === "none")) {
      fail("CONFLICT", "先完成一次隔日独立正确复测，再记录变式迁移。");
    }
    if (command.outcome === "read") fail("VALIDATION", "变式记录需要实际作答，阅读解析不算变式完成。");
    if (command.note.trim().length < 6) fail("VALIDATION", "请在备注说明陌生变式的题目来源或变化，至少 6 个字；此记录仍属于自评。");
  }
  const record: ExamSourceRecord = {
    id: `source-${state.sourceRecords.length + 1}-${command.clientKey.slice(0, 65)}`,
    sourceId: command.sourceId, phase: command.phase, outcome: command.outcome, assistance: command.assistance,
    durationMinutes: command.durationMinutes, errorCause: command.errorCause, note: command.note, recordedAt: now,
    ...(command.answerText !== undefined ? { answerText: command.answerText } : {}),
    ...(command.workSourceId !== undefined ? { workSourceId: command.workSourceId } : {}),
    ...(command.workSourceVersion !== undefined ? { workSourceVersion: command.workSourceVersion } : {}),
    ...(command.reviewId !== undefined ? { reviewId: command.reviewId } : {}),
    ...(command.referenceChecked !== undefined ? { referenceChecked: command.referenceChecked } : {}),
  };
  state.sourceRecords.push(record);
}

function openLesson(state: ExamSprintState, command: Extract<ExamSprintCommand, { action: "open_lesson" }>, pack: ExamPack, now: string, context?: ExamSelectionContext): void {
  const active = activeRun(state);
  const current = active ? currentAttempt(state, active) : null;
  if (active && isMock(active.mode)) fail("CONFLICT", "模拟交卷前不能打开串讲，请先完成交卷。");
  if ((active?.id ?? null) !== command.expectedRunId || (current?.id ?? null) !== command.expectedAttemptId) {
    fail("CONFLICT", "练习上下文已改变，请重新载入后再打开串讲。");
  }
  const lesson = pack.lessons.find(item => item.id === command.lessonId) ?? fail("NOT_FOUND", "串讲不存在。");
  const mapping = validExamLessonExposure(lesson);
  if (!mapping) fail("CONFLICT", "此题包版本没有已审核的串讲曝光映射，暂不可打开；请保留原题包记录。");
  if (command.packVersion !== pack.version || command.contentFingerprint !== mapping.contentFingerprint || command.mappingVersion !== mapping.mappingVersion) {
    fail("CONFLICT", "串讲版本已改变，请重新载入后再打开。");
  }
  const exposures = state.lessonExposures ??= [];
  const existing = exposures.find(exposure => exposure.packId === pack.id && exposure.packVersion === pack.version
    && exposure.runId === (active?.id ?? null) && exposure.lessonId === lesson.id
    && exposure.contentFingerprint === mapping.contentFingerprint && exposure.mappingVersion === mapping.mappingVersion);
  if (!existing) exposures.push({
    id: `lesson-exposure-${exposures.length + 1}-${command.clientKey.slice(0, 60)}`,
    clientKey: command.clientKey, openedAt: now, runId: active?.id ?? null,
    lessonId: lesson.id, packId: pack.id, packVersion: pack.version,
    ...structuredClone(mapping),
  });
  if (current) captureExamAttemptExposures(current, state, pack, context?.exposureCoverage);
}

function switchToTeaching(state: ExamSprintState, command: Extract<ExamSprintCommand, { action: "switch_to_teaching" }>, pack: ExamPack, now: string, context?: ExamSelectionContext): void {
  const run = activeRun(state), attempt = run ? currentAttempt(state, run) : null;
  if (!run || !isMock(run.mode) || run.id !== command.expectedRunId || !attempt
    || attempt.id !== command.expectedAttemptId || attempt.answeredAt !== null) {
    fail("CONFLICT", "模拟或当前未提交题已改变，请重新载入；已提交答案不能转为受助作答。");
  }
  if (run.deadlineAt && at(now) >= at(run.deadlineAt)) {
    fail("CONFLICT", "模拟时间已到，不能转为教学；请先交卷查看结果。");
  }
  const question = questionFor(pack, attempt.questionId);
  if (command.lessonId !== question.lessonId || at(now) < at(attempt.presentedAt)) fail("CONFLICT", "转教学的题目或作答时间无效，请重新载入后再试。");
  const lesson = pack.lessons.find(item => item.id === command.lessonId);
  const mapping = lesson ? validExamLessonExposure(lesson) : null;
  if (!mapping || command.packVersion !== pack.version || command.contentFingerprint !== mapping.contentFingerprint
    || command.mappingVersion !== mapping.mappingVersion || command.confirmedEndScoredMock !== true) {
    fail("CONFLICT", "串讲版本或已审核曝光映射未能确认，请重新载入。");
  }
  const exposures = state.lessonExposures ??= [];
  const exposureId = `lesson-exposure-${exposures.length + 1}-${command.clientKey.slice(0, 60)}`;
  exposures.push({ id: exposureId, clientKey: command.clientKey, openedAt: now, runId: run.id,
    lessonId: lesson!.id, packId: pack.id, packVersion: pack.version, ...structuredClone(mapping) });
  if (!attempt.help.some(help => help.kind === "solution")) attempt.help.push({ kind: "solution", at: now });
  captureExamAttemptExposures(attempt, state, pack, context?.exposureCoverage);
  run.completedAt = now;
  run.conversion = { runId: run.id, packId: pack.id, packVersion: pack.version, attemptId: attempt.id,
    lessonId: lesson!.id, exposureId, clientKey: command.clientKey, convertedAt: now,
    contentFingerprint: mapping.contentFingerprint, mappingVersion: mapping.mappingVersion };
}

export function applyExamSprintCommand(state: ExamSprintState, command: ExamSprintCommand, pack: ExamPack, now: string, context?: ExamSelectionContext): ExamSprintState {
  const result = structuredClone(state);
  if (command.action === "switch_to_teaching") {
    switchToTeaching(result, command, pack, now, context);
    return result;
  }
  if (command.action === "open_lesson") {
    openLesson(result, command, pack, now, context);
    return result;
  }
  if (command.action === "configure") {
    result.examDate = command.examDate;
    result.dailyMinutes = command.dailyMinutes;
    return result;
  }
  if (command.action === "source") {
    recordSource(result, command, pack, now);
    return result;
  }
  const active = activeRun(result);
  if (command.action === "start") {
    const topicId = command.topicId;
    if (topicId !== undefined && (command.mode !== "practice" || !pack.topics.some(topic => topic.id === topicId))) {
      fail("VALIDATION", "只能为针对练习选择当前题包中的有效章节。");
    }
    if (active) fail("CONFLICT", "请先完成或交卷当前练习，再开始下一轮。");
    if (isMock(command.mode) && result.runs.some(run => run.mode === command.mode)) fail("CONFLICT", "这套保留模拟已经开启过，不能重复用同一套题证明考前水平；请选择另一套或转入练习。");
    const selection = topicId === undefined
      ? selectQuestions(result, pack, command.mode, now, context)
      : selectTopicPracticeQuestions(result, pack, topicId, context);
    const first = selection.ids[0];
    if (!first) fail("CONFLICT", selection.note || "当前模式没有可用题目。");
    const minutes = selection.ids.reduce((sum, id) => sum + questionFor(pack, id).estimatedMinutes, 0);
    const run: ExamRun = {
      id: `run-${result.runs.length + 1}-${command.clientKey.slice(0, 65)}`, mode: command.mode,
      questionIds: selection.ids, startedAt: now, completedAt: null,
      deadlineAt: isMock(command.mode) ? new Date(at(now) + minutes * 60_000).toISOString() : null,
    };
    result.runs.push(run);
    result.attempts.push(newAttempt(run, first, result, pack, command.clientKey, now, context));
    return result;
  }
  if (command.action === "error") {
    const attempt = result.attempts.find(item => item.id === command.attemptId) ?? fail("NOT_FOUND", "作答记录不存在。");
    if (!attempt.answeredAt) fail("CONFLICT", "请先作答，再标记错因。");
    const run = result.runs.find(item => item.id === attempt.runId);
    if (run && isMock(run.mode) && !run.completedAt) fail("CONFLICT", "模拟交卷后才能标记错因。");
    attempt.errorCause = command.errorCause;
    return result;
  }
  if (!active) fail("CONFLICT", "当前没有进行中的练习。");
  if (command.action === "finish") {
    if (active.id !== command.runId) fail("NOT_FOUND", "当前练习不存在。");
    active.completedAt = now;
    return result;
  }
  const attempt = currentAttempt(result, active) ?? fail("NOT_FOUND", "当前题目不存在。");
  if (command.action === "next") {
    if (active.id !== command.runId) fail("NOT_FOUND", "当前练习不存在。");
    if (!attempt.answeredAt) fail("CONFLICT", "请先作答；需要结束时可直接交卷，未答题保留为未答。");
    const nextId = active.questionIds[active.questionIds.indexOf(attempt.questionId) + 1];
    if (!nextId) active.completedAt = now;
    else {
      if (active.deadlineAt && at(now) >= at(active.deadlineAt)) fail("CONFLICT", "模拟时间已到，请交卷查看反馈。");
      result.attempts.push(newAttempt(active, nextId, result, pack, command.clientKey, now, context));
    }
    return result;
  }
  if (attempt.id !== command.attemptId) fail("CONFLICT", "只能操作当前题目。");
  if (attempt.answeredAt) fail("CONFLICT", "本题已经提交，首次作答不能覆盖。");
  if (command.action === "help") {
    captureExamAttemptExposures(attempt, result, pack, context?.exposureCoverage);
    if (isMock(active.mode) && command.kind !== "external") fail("CONFLICT", "限时模拟不提供帮助，请交卷后查看解析。");
    if (!attempt.help.some(help => help.kind === command.kind)) attempt.help.push({ kind: command.kind, at: now });
    return result;
  }
  if (active.deadlineAt && at(now) >= at(active.deadlineAt)) fail("CONFLICT", "模拟时间已到，不能继续提交答案；请交卷。");
  const question = questionFor(pack, attempt.questionId);
  if (!question.options.some(option => option.id === command.answer)) fail("VALIDATION", "请选择本题提供的有效选项。");
  if (at(now) < at(attempt.presentedAt)) fail("VALIDATION", "作答时间不能早于题目展示时间。");
  captureExamAttemptExposures(attempt, result, pack, context?.exposureCoverage);
  attempt.answer = command.answer;
  attempt.correct = command.answer === question.answer;
  attempt.answeredAt = now;
  attempt.confidence = command.confidence;
  attempt.durationSeconds = Math.round((at(now) - at(attempt.presentedAt)) / 1000);
  return result;
}

function attemptView(attempt: ExamAttempt, state: ExamSprintState, pack: ExamPack, context?: ExamSelectionContext): ExamAttemptView {
  const original = questionFor(pack, attempt.questionId);
  const { answer, explanation, hint, pool: _pool, partSnapshot: _partSnapshot, ...question } = original;
  const run = state.runs.find(item => item.id === attempt.runId);
  const sealed = Boolean(run && isMock(run.mode) && !run.completedAt);
  const reveal = !sealed && (attempt.answeredAt !== null || attempt.help.some(help => help.kind === "solution") || Boolean(run && isMock(run.mode) && run.completedAt));
  const { prediction, resultMetadata: _resultMetadata, ...publicAttempt } = structuredClone(attempt);
  return {
    ...publicAttempt, ...(!sealed && prediction ? { prediction } : {}), correct: sealed ? null : attempt.correct, question: structuredClone(question),
    feedback: reveal ? { answer, explanation } : null,
    hint: !sealed && attempt.help.some(help => help.kind === "hint") ? hint : null,
    independent: !sealed && independent(attempt, state, pack, context),
  };
}

function workload(state: ExamSprintState, pack: ExamPack, now: string, context?: ExamSelectionContext): ExamSprintOverview["workload"] {
  const records = currentSourceRecords(state, context);
  const covered = new Set(records.filter(record => record.outcome !== "read").map(record => record.sourceId));
  const remaining = pack.sourceItems.filter(source => !covered.has(source.id));
  const estimates = remaining.map(source => {
    const samples = records.filter(record => record.outcome !== "read" && record.durationMinutes > 0
      && pack.sourceItems.find(item => item.id === record.sourceId)?.kind === source.kind);
    return samples.length ? samples.reduce((sum, record) => sum + record.durationMinutes, 0) / samples.length : null;
  });
  const estimatedMinutes = estimates.some(estimate => estimate === null) ? null : Math.ceil(estimates.reduce<number>((sum, estimate) => sum + (estimate ?? 0), 0));
  const days = state.examDate ? Math.floor((at(`${state.examDate}T00:00:00.000Z`) - at(`${now.slice(0, 10)}T00:00:00.000Z`)) / DAY) : null;
  const availableMinutes = days === null ? null : Math.max(0, days - 2) * state.dailyMinutes;
  return {
    remainingItems: remaining.length, estimatedMinutes, availableMinutes,
    overloaded: estimatedMinutes !== null && availableMinutes !== null && estimatedMinutes > availableMinutes,
    message: (estimatedMinutes === null ? "部分原题题型缺少实际用时；先完成并记录每种题型，暂不虚构总用时。"
      : `按已记录的同题型实际用时估算，未覆盖原题约需 ${estimatedMinutes} 分钟。`)
      + (availableMinutes === null ? "设置考试日期后计算预算。" : `考前最后两天已预留给模拟与复盘，之前可用 ${availableMinutes} 分钟。`)
      + "此处只估算首次覆盖，不包含补弱和隔日复测；原题结果为自评。",
  };
}

export function examSprintOverview(state: ExamSprintState, pack: ExamPack, now: string, context?: ExamSelectionContext): ExamSprintOverview {
  const skills = skillSummaries(state, pack, context);
  const attempts = state.attempts.map(attempt => attemptView(attempt, state, pack, context));
  const active = activeRun(state);
  const current = active ? currentAttempt(state, active) : null;
  const evidence = visibleEvidence(state, context);
  const { questions: _questions, lessons, ...packMetadata } = pack;
  const publicPack: ExamSprintOverview["pack"] = {
    ...packMetadata,
    lessons: lessons.map(lesson => {
      const mapping = validExamLessonExposure(lesson);
      return { id: lesson.id, topicId: lesson.topicId, title: lesson.title, summary: lesson.summary,
        exposureIdentity: mapping ? { packVersion: pack.version, contentFingerprint: mapping.contentFingerprint, mappingVersion: mapping.mappingVersion } : null };
    }),
  };
  const lessonContents: ExamSprintOverview["lessonContents"] = active && isMock(active.mode) ? [] : lessons.flatMap(lesson => {
    const mapping = validExamLessonExposure(lesson);
    if (!mapping) return [];
    const matching = (state.lessonExposures ?? []).filter(item => item.packId === pack.id && item.packVersion === pack.version
      && (!active || item.runId === active.id)
      && item.lessonId === lesson.id && item.contentFingerprint === mapping.contentFingerprint && item.mappingVersion === mapping.mappingVersion);
    const conversion = !active ? state.runs.at(-1)?.conversion : undefined;
    const exposure = matching.find(item => item.id === conversion?.exposureId) ?? matching[0];
    return exposure ? [{ exposureId: exposure.id, lesson: structuredClone(lesson) }] : [];
  });
  const { attempts: _attempts, ...publicState } = state;
  const distinctSources = (predicate: (record: ExamSourceRecord) => boolean) => new Set(currentSourceRecords(state, context).filter(predicate).map(record => record.sourceId)).size;
  const arrangementNote = active?.mode === "practice" ? activePracticeNote(active, state, pack, context)
    : selectQuestions(active ? { ...state, runs: state.runs.filter(run => run.id !== active.id),
      attempts: state.attempts.filter(attempt => attempt.runId !== active.id) } : state, pack, active?.mode ?? "practice", now, context).note;
  const recheck = recheckSkills(state, pack, context);
  const recommendations: ExamSprintOverview["recommendations"] = skills.filter(skill => skill.status === "weak" || skill.status === "usable").map(skill => ({
    title: `${skill.status === "weak" ? "补齐" : "验证保持"}：${skill.title}`, reason: skill.reason + (skill.dueAt ? ` 复测不早于 ${skill.dueAt}。` : ""), lessonId: skill.lessonId,
    mode: skill.dueAt && at(skill.dueAt) <= at(now) ? "retest" : "practice",
  }));
  for (const skill of skills.filter(skill => skill.status === "untested" && recheck.has(skill.skillId))) {
    recommendations.push({ title: `重新确认：${skill.title}`, reason: skill.reason, lessonId: skill.lessonId, mode: "practice" });
  }
  recommendations.push({ title: active ? "本轮题目安排" : "下一轮练习安排",
    reason: arrangementNote,
    lessonId: null, mode: "practice" });
  return {
    pack: structuredClone(publicPack), state: { ...structuredClone(publicState), lessonExposures: structuredClone(state.lessonExposures ?? []) }, attempts, lessonContents,
    activeRun: active ? structuredClone(active) : null,
    currentAttempt: current ? attempts.find(attempt => attempt.id === current.id) ?? null : null,
    skills, recommendations, workload: workload(state, pack, now, context),
    summary: {
      sourceTotal: pack.sourceItems.length,
      sourceCovered: distinctSources(record => record.outcome !== "read"),
      sourceIndependent: distinctSources(record => record.outcome === "correct" && record.assistance === "none" && record.phase !== "variant"),
      sourceDelayed: distinctSources(record => record.phase === "delayed" && record.outcome === "correct" && record.assistance === "none"),
      onlineAnswered: evidence.filter(attempt => attempt.answeredAt !== null).length,
      onlineIndependentCorrect: evidence.filter(attempt => attempt.correct === true && independent(attempt, state, pack, context)).length,
    },
  };
}
