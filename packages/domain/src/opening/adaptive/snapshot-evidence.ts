import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "../evidence-eligibility";
import { summarizeObservations, type CourseEvidence } from "../learning-summary";
import type { SnapshotObservation, SnapshotSkillSummary } from "./snapshot-sources";
import { adaptiveSkillIdentity, normalizeSkillLabelKey } from "./skill-identity";

/** Full-evidence summaries and per-observation eligibility, matching the learning summary rules. */
export function toSnapshotEvidence(
  evidence: CourseEvidence,
  now: Date,
): { summaries: SnapshotSkillSummary[]; observations: SnapshotObservation[] } {
  // Reuse the earliest observed spelling. Labels are still display identities,
  // but whitespace/case aliases must not become two separate daily suggestions.
  const labels = new Map<string, string>();
  // A quarantined answer is retained in history, not an extra weak performance
  // or a latest-attempt override of a valid independent result.
  const performance = evidence.observations.filter(row => {
    const context=evidence.evidenceContexts[row.id]?.context;
    return !context?.materialAnswerDisputed && context?.materialAssessmentValidity !== "changed" && context?.materialAssessmentValidity !== "unknown";
  });
  const ordered = [...performance].sort((a, b) =>
    (evidence.evidenceContexts[a.id]?.observation.submittedAt ?? Date.parse(a.submittedAt ?? a.occurredAt))
    - (evidence.evidenceContexts[b.id]?.observation.submittedAt ?? Date.parse(b.submittedAt ?? b.occurredAt))
    || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const key = adaptiveSkillIdentity(normalizeSkillLabelKey(row.skillLabel), evidence.evidenceContexts[row.id]?.observation.requirementKey);
    if (!labels.has(key)) labels.set(key, row.skillLabel);
  }
  const canonical = performance.map(row => ({
    ...row, skillLabel: labels.get(adaptiveSkillIdentity(normalizeSkillLabelKey(row.skillLabel), evidence.evidenceContexts[row.id]?.observation.requirementKey))!,
  }));
  const summaries = summarizeObservations(canonical, now.toISOString(), {
    evidenceContexts: evidence.evidenceContexts,
  }).map((row) => ({ skillLabel: row.skillLabel, requirementKey: row.requirementKey, status: row.status, lastObservedAt: row.lastObservedAt }));
  const observations = canonical.map((row): SnapshotObservation => {
    const input = evidence.evidenceContexts[row.id];
    const captured = input?.observation ?? {
      courseId: row.courseId,
      problemId: row.problemId,
      assistance: row.assistance,
      outcome: row.outcome,
      verdictSource: row.verdictSource,
    };
    const context = input?.context ?? {};
    const eligibility = evaluateEvidenceEligibility(captured, context);
    // A revision keeps the original attempt time, as in summarizeObservations.
    const attemptedAt = input?.observation.submittedAt ?? Date.parse(row.submittedAt ?? row.occurredAt);
    return {
      id: row.id,
      skillLabel: row.skillLabel,
      requirementKey: input?.observation.requirementKey ?? null,
      itemVersionId: input?.observation.itemVersionId ?? null,
      attemptedAt: new Date(attemptedAt).toISOString(),
      assistance: resolveEvidenceAssistance(captured, context),
      verifiedCorrect: eligibility.verifiedCorrect,
      independentAttempt: eligibility.independentAttempt,
      usableForCurrentVersion: eligibility.usableForCurrentVersion,
      problemId: row.problemId ?? null,
      ...(row.outcome === "incorrect" && eligibility.verifiedCorrect === "no" && eligibility.usableForCurrentVersion === "yes" ? {
        errors: row.verdictSource === "ai_graded" && row.aiEvaluation
          ? row.aiEvaluation.criteria.filter(criterion => criterion.verdict === "incorrect").slice(0, 3)
            .map(criterion => ({ observationId: row.id, label: criterion.label.slice(0, 200), feedback: criterion.feedback.slice(0, 1000), source: "ai_feedback" as const,
              ...(row.aiEvaluation?.misconceptionId && row.aiEvaluation.misconceptionId !== "other" ? { misconceptionId: row.aiEvaluation.misconceptionId } : {}) }))
          : row.serverEvaluation?.evaluatorVersion === "span-exact-v1" && row.serverEvaluation.skills ? Object.entries(row.serverEvaluation.skills).filter(([, value]) => value === "incorrect").slice(0, 3)
            .map(([label]) => ({ observationId: row.id, label, feedback: "这一步在先前作答中有误，结合原题确认原因。", source: "verified_steps" as const })) : [],
      } : {}),
    };
  });
  return { summaries, observations };
}
