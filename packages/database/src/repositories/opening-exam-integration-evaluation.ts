import { isDeepStrictEqual } from "node:util";
import { examQuestionPartsSchema } from "@aistudy/contracts";
import type { ExamAttempt, ExamPack, ExamQuestion, ExamSprintState, QuestionPartAssistance, Scope } from "@aistudy/contracts";
import { evaluateExamChoice, evaluateExamQuestionParts, parseExamChoiceSpec } from "@aistudy/domain";
import { readCourseRequirements } from "./opening-course-route-read";

/** Resolve declared keys only inside the owner/course; never infer from labels or positions. */
export async function captureExamPartRequirements(tx: TransactionSql, scope: Scope, courseId: string, question: ExamQuestion) {
  const requirements = await readCourseRequirements(tx, scope, courseId);
  return question.partSnapshot!.parts.map(part => {
    const matches = requirements.filter(row => row.requirementKey === part.requirementKey && row.approvedAt);
    if (matches.length !== 1) throw learningError("CONFLICT", "分项要求尚未在本课程唯一确认");
    const row = matches[0]!;
    return { partId: part.partId, identityRefId: part.identityRefId, requirementKey: part.requirementKey,
      id: row.id, revision: row.revision, stableSkillId: row.stableSkillId, nodeId: row.knowledgeNodeId };
  });
}

/** Existing private state JSON owns part results. Whole-question facts/score remain untouched. */
export async function publishExamPartResult(tx: TransactionSql, scope: Scope, sprintId: string, pack: ExamPack,
  state: ExamSprintState, attempt: ExamAttempt, row: Record<string, unknown>, observationId: string, assistance: QuestionPartAssistance) {
  const question = pack.questions.find(item => item.id === attempt.questionId)!;
  if (!question.partSnapshot) return;
  const intent = row.create_intent as { examSprint?: { partSnapshot?: unknown } } | null;
  const pinned = examQuestionPartsSchema.safeParse(intent?.examSprint?.partSnapshot);
  const normalize = (snapshot: NonNullable<typeof question.partSnapshot>) => ({ ...snapshot,
    parts: [...snapshot.parts].sort((a, b) => a.partId.localeCompare(b.partId)) });
  if (!pinned.success || !isDeepStrictEqual(normalize(pinned.data), normalize(question.partSnapshot)))
    throw learningError("CONFLICT", "分项题目版本与首次展示快照不符");
  const questionEvaluation = evaluateExamQuestionParts(question, pack, attempt.answer!, observationId, assistance)!;
  attempt.resultMetadata = { questionEvaluation };
  await tx`UPDATE opening_exam_sprints SET state=${tx.json(state as never)}
    WHERE id=${sprintId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
}
import type { TransactionSql } from "postgres";
import { learningError, learningIso } from "./opening-learning-facts";
import { parseExamBinding } from "./opening-exam-integration-facts";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

/** Server-only publication adapter. Public submit APIs cannot publish linked mock answers. */
export async function evaluateOpeningExamAttempt(tx: TransactionSql, scope: Scope,
  attempt: Record<string, unknown> | undefined, answer: string, admittedSources: readonly Record<string, unknown>[], allowed: boolean,
) {
  if (!attempt?.item_version_id) {
    if ((attempt?.create_intent as { examSprint?: unknown } | null)?.examSprint) throw learningError("CONFLICT", "冲刺题目身份缺失");
    return null;
  }
  const [link] = await tx`SELECT l.*,s.pack_snapshot,s.state,b.binding,v.evaluation_spec,v.stem_snapshot,v.source_id,v.source_version,
      p.stem_snapshot AS current_stem,p.source_version AS current_version
    FROM opening_exam_attempt_links l
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    JOIN opening_exam_bindings b ON b.sprint_id=s.id
    JOIN opening_learning_item_versions v ON v.id=${String(attempt.item_version_id)} AND v.workspace_id=s.workspace_id AND v.owner_user_id=s.owner_user_id
      AND v.problem_id=${String(attempt.problem_id)} AND v.course_id=${String(attempt.course_id)}
    JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
    WHERE l.learning_attempt_id=${String(attempt.id)} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}`;
  if (!link) {
    if ((attempt.create_intent as { examSprint?: unknown } | null)?.examSprint) throw learningError("CONFLICT", "冲刺作答身份无法校验");
    return null;
  }
  if (!allowed) throw learningError("CONFLICT", "冲刺题目须从冲刺入口提交；模拟卷须交卷后发布");
  const { pack, state } = parseExamSprintSnapshot(link.pack_snapshot, link.state), binding = parseExamBinding(link.binding);
  const examAttempt = state.attempts.find(item => item.id === link.exam_attempt_id);
  const run = state.runs.find(item => item.id === examAttempt?.runId);
  const question = pack.questions.find(item => item.id === examAttempt?.questionId);
  const skill = binding.skills.find(item => item.skillId === question?.skillId), spec = parseExamChoiceSpec(link.evaluation_spec);
  if (!examAttempt || !run || !question || !skill || !spec || examAttempt.answer !== answer || link.submitted_answer !== answer
    || examAttempt.answeredAt !== learningIso(link.captured_at) || !examAttempt.answeredAt
    || ((run.mode === "mock-a" || run.mode === "mock-b") && run.completedAt === null)) {
    throw learningError("CONFLICT", "冲刺提交尚未捕获或未交卷");
  }
  if (binding.courseId !== attempt.course_id || skill.nodeId !== link.node_id || skill.requirementKey !== attempt.requirement_key
    || skill.requirementKey !== link.requirement_key || spec.questionId !== question.id || spec.familyId !== question.familyId
    || link.source_id !== binding.packSourceId || link.stem_snapshot !== question.prompt
    || link.current_stem !== link.stem_snapshot || Number(link.current_version) !== Number(link.source_version)) {
    throw learningError("CONFLICT", "冲刺题目、技能或版本身份已变化");
  }
  const versions = attempt.source_versions as Record<string, number>;
  if (versions[binding.packSourceId] !== Number(link.source_version)
    || admittedSources.some(source => versions[String(source.id)] !== Number(source.version))) throw learningError("CONFLICT", "冲刺材料版本已变化");
  return { ...evaluateExamChoice(spec, pack, answer), specVersion: "exam-choice-v1" as const,
    capturedSubmittedAt: examAttempt.answeredAt, priorFeedback: false };
}
