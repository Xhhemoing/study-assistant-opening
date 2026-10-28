import { isRecord, isUuid } from "./backup-validation";
import { spanTutorAutomationSchema } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "./span-teaching-catalog";

type Row = Record<string, unknown>;
const at = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
const same = (left: unknown, right: unknown) => isUuid(left) && isUuid(right) && left.toLowerCase() === right.toLowerCase();
const scoped = (left: Row, right: Row) => same(left.workspace_id, right.workspace_id) && same(left.owner_user_id, right.owner_user_id);
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function validateCourseProtocol(protocol: Row, row: Row, tables: Record<string, Row[]>, errors: string[]): boolean {
  const keys = ["protocolId", "goalId", "goalRevision", "requirementId", "requirementRevision", "stableSkillId", "baselineObservationId", "baselineRootId", "originActivityId", "minutes"];
  if (Object.keys(protocol).some(key => !keys.includes(key))
    || !["goalId", "requirementId", "stableSkillId", "baselineObservationId", "baselineRootId", "originActivityId"].every(key => isUuid(protocol[key]))
    || !positiveRevision(protocol.goalRevision) || !positiveRevision(protocol.requirementRevision)
    || typeof protocol.minutes !== "number" || !Number.isInteger(protocol.minutes) || protocol.minutes < 5 || protocol.minutes > 180 || row.purpose !== "retest") {
    errors.push("retest learning protocol is invalid"); return false;
  }
  const goal = tables.course_goals?.find(item => same(item.id, protocol.goalId) && same(item.workspace_id, row.workspace_id));
  const requirement = tables.course_requirements?.find(item => same(item.id, protocol.requirementId) && scoped(item, row));
  const activity = tables.opening_teaching_activities?.find(item => same(item.id, protocol.originActivityId) && scoped(item, row));
  // Older revisions are archive facts. Live restoration never grants their former authority.
  if (!goal || !requirement || !activity
    || !same(requirement.course_id, row.course_id) || !same(activity.course_id, row.course_id)
    || !same(requirement.stable_skill_id, protocol.stableSkillId) || requirement.requirement_key !== row.requirement_key
    || !positiveRevision(goal.revision) || !positiveRevision(requirement.revision)
    || protocol.goalRevision > goal.revision || protocol.requirementRevision > requirement.revision
    || (protocol.requirementRevision === requirement.revision && (!Array.isArray(requirement.goal_ids) || requirement.goal_ids.length > 0 && !requirement.goal_ids.some(id => same(id, goal.id))))) {
    errors.push("course retest protocol reference is missing or mismatched"); return false;
  }
  return true;
}

/** These receipts preserve learning identity, never imported scoring authority. */
export function validateBackupRetestProtocols(tables: Record<string, Row[]>, errors: string[]): void {
  const retests = tables.opening_retest_activities ?? [], observations = tables.opening_learning_observations ?? [];
  const aliases = new Set<string>(), accepts = new Set<string>();
  for (const row of retests) {
    const scope = `${row.workspace_id}/${row.owner_user_id}`.toLowerCase();
    const alias = row.candidate_reference_id;
    if (alias != null) {
      if (!isUuid(alias)) errors.push("retest candidate reference identity is invalid");
      else {
        const key = `${scope}/${alias.toLowerCase()}`;
        if (aliases.has(key) || retests.some(other => scoped(row, other) && !same(row.id, other.id) && same(alias, other.id))) {
          errors.push("retest candidate reference identity is ambiguous");
        }
        aliases.add(key);
      }
    }
    const receipt = row.accept_client_key;
    if (receipt != null) {
      const task = (tables.opening_tasks ?? []).find(item => same(item.id, row.task_id) && scoped(item, row));
      if (typeof receipt !== "string" || receipt.length < 8 || receipt.length > 160
        || !isUuid(alias) || !isUuid(row.task_id) || !Number.isFinite(at(row.accepted_at)) || row.learning_protocol == null
        || !task || !same(task.course_id, row.course_id) || task.skill_label !== row.skill_label || task.requirement_key !== row.requirement_key) {
        errors.push("retest acceptance receipt is incomplete");
      } else {
        const key = `${scope}/${receipt}`;
        if (accepts.has(key)) errors.push("retest acceptance receipt is duplicated");
        accepts.add(key);
      }
    }
    // Legacy archives cannot establish a formal retention protocol from timing alone.
    if (row.learning_protocol == null) continue;
    const protocol = row.learning_protocol;
    if (isRecord(protocol) && protocol.protocolId === "course-route-delayed-v1") {
      if (!validateCourseProtocol(protocol, row, tables, errors)) continue;
    } else if (!isRecord(protocol) || Object.keys(protocol).some(key => !["protocolId", "baselineObservationId", "baselineRootId", "priorAnswerPolicy", "tutorAutomation"].includes(key))
      || (protocol.tutorAutomation !== undefined && !spanTutorAutomationSchema.safeParse(protocol.tutorAutomation).success)
      || protocol.protocolId !== "span-delayed-3d-v1" || protocol.priorAnswerPolicy !== "require_unseen_problem"
      || !isUuid(protocol.baselineObservationId) || !isUuid(protocol.baselineRootId)
      || row.purpose !== "retest" || row.skill_label !== SPAN_SKILL_LABEL || row.requirement_key !== SPAN_REQUIREMENT_KEY) {
      errors.push("retest learning protocol is invalid"); continue;
    }
    const baseline = observations.find(item => same(item.id, protocol.baselineObservationId) && scoped(item, row));
    const root = observations.find(item => same(item.id, protocol.baselineRootId) && scoped(item, row));
    if (!baseline || !root || !same(baseline.root_observation_id ?? baseline.id, root.id)
      || !same(baseline.course_id, row.course_id) || !same(root.course_id, row.course_id)
      || baseline.requirement_key !== row.requirement_key || baseline.skill_label !== row.skill_label
      || root.requirement_key !== row.requirement_key || root.skill_label !== row.skill_label || !isUuid(baseline.attempt_id)) {
      errors.push("retest learning protocol baseline is missing or mismatched"); continue;
    }
    const submitted = at(baseline.submitted_at), recorded = at(baseline.recorded_at), earliest = at(row.not_before_at);
    if (!Number.isFinite(submitted) || !Number.isFinite(recorded) || !Number.isFinite(earliest)
      || earliest < Math.max(submitted, recorded) + 72 * 60 * 60 * 1000) errors.push("retest learning protocol requires at least 72 hours after sealing");
    // Historical replacements/retractions remain valid archive facts. Live
    // eligibility checks the effective head again after restoration.
  }
}
