import type { Scope } from "@aistudy/contracts";
import { evaluateExamChoice, parseExamChoiceSpec } from "@aistudy/domain";
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
