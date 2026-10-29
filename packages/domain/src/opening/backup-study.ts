import { composerPurposeSchema, studyContextAnchorSchema, studyIntentChangeSchema, studySessionIntentSchema } from "@aistudy/contracts";
import { validateLearningDecision, type LearningDecisionInput } from "./learning-decision";
import { isRecord, isUuid } from "./backup-validation";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
const rows = (tables: Tables, table: string) => tables[table] ?? [];
const byId = (tables: Tables, table: string) => new Map(rows(tables, table).map(row => [row.id, row]));
const timestamp = (value: unknown): number | null => {
  const result = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : null;
};
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const sameScope = (a: Row, b: Row) => a.workspace_id === b.workspace_id && a.owner_user_id === b.owner_user_id;

/** Restored anchors keep their identities; absent historical anchors remain unknown. */
export function validateBackupStudy(tables: Tables, errors: string[]): void {
  const activities = byId(tables, "opening_teaching_activities"), attempts = byId(tables, "opening_learning_attempts");
  const items = byId(tables, "opening_learning_item_versions"), turns = byId(tables, "opening_turns");
  const sessions = byId(tables, "opening_learning_sessions"), sources = byId(tables, "opening_sources");
  const chunks = byId(tables, "opening_source_chunks"), conversations = byId(tables, "opening_conversations");
  const versions = new Set(rows(tables, "opening_source_versions").map(row => `${row.source_id}/${row.version}`));
  for (const source of sources.values()) versions.add(`${source.id}/${source.version}`);
  const owner = (row: Row): unknown => row.owner_user_id ?? sessions.get(row.session_id)?.owner_user_id
    ?? conversations.get(turns.get(row.turn_id)?.conversation_id)?.owner_user_id ?? conversations.get(row.conversation_id)?.owner_user_id;
  const anchor = (row: Row) => {
    if (row.context_anchor == null) return;
    const parsed = studyContextAnchorSchema.safeParse(row.context_anchor);
    if (!parsed.success) { errors.push("Study context anchor is invalid"); return; }
    const value = parsed.data;
    const expectedCourse = "course_id" in row ? row.course_id
      : sessions.get(row.session_id)?.course_id ?? conversations.get(row.conversation_id)?.course_id;
    if (value.courseId != null && expectedCourse !== undefined && value.courseId !== expectedCourse) errors.push("Study anchor course mismatch");
    for (const [id, collection, label] of [[value.activityId, activities, "activity"], [value.attemptId, attempts, "attempt"], [value.itemVersionId, items, "item"]] as const) {
      if (id == null) continue;
      const reference = collection.get(id);
      if (!reference || reference.workspace_id !== row.workspace_id || reference.owner_user_id !== owner(row)
        || (value.courseId != null && reference.course_id !== value.courseId)) errors.push(`Study anchor ${label} scope or identity mismatch`);
    }
    const attempt = attempts.get(value.attemptId);
    if (attempt && ((value.activityId != null && value.activityId !== attempt.activity_id)
      || (value.itemVersionId != null && value.itemVersionId !== attempt.item_version_id))) errors.push("Study anchor attempt relationships mismatch");
    if (value.sourceId != null && (!sources.has(value.sourceId)
      || (value.sourceVersion != null && !versions.has(`${value.sourceId}/${value.sourceVersion}`)))) errors.push("Study anchor source version is missing");
    if (value.chunkId != null) {
      const chunk = chunks.get(value.chunkId);
      if (!chunk || chunk.source_id !== value.sourceId || (value.sourceVersion != null && chunk.source_version !== value.sourceVersion)
        || (value.page != null && chunk.page !== value.page)) errors.push("Study anchor chunk relationships mismatch");
    }
    if (value.blockId != null) {
      const specs = rows(tables, "opening_teaching_activity_specs").filter(spec => spec.activity_id === value.activityId
        && spec.version === value.contentVersion && Array.isArray(spec.block_order));
      if (!specs.some(spec => (spec.block_order as Row[]).some(block => block.blockId === value.blockId))) errors.push("Study anchor block version is missing");
    }
  };
  for (const row of rows(tables, "opening_turns")) {
    anchor(row);
    if (row.composer_purpose != null && !composerPurposeSchema.safeParse(row.composer_purpose).success) errors.push("Study composer purpose is invalid");
  }
  for (const row of rows(tables, "opening_learning_attempts")) anchor(row);
  const releaseKeys = new Set<string>();
  const counters = new Map(rows(tables, "opening_workspace_history_revisions").map(row => [`${row.workspace_id}/${row.owner_user_id}`, row.revision]));
  for (const row of rows(tables, "opening_help_exposures")) {
    anchor(row);
    if (row.hint_stage != null && (!Number.isInteger(row.hint_stage) || Number(row.hint_stage) < 1 || Number(row.hint_stage) > 4)) errors.push("Study exposure hint stage is invalid");
    if (row.initiated_by != null && row.initiated_by !== "user" && row.initiated_by !== "assistant") errors.push("Study exposure initiator is invalid");
    // Pre-upgrade facts have no release metadata. Never manufacture release or acknowledgement.
    if (row.release_key == null) continue;
    if (!isUuid(row.id) || !isUuid(owner(row)) || typeof row.release_key !== "string" || row.release_key.length < 8 || row.release_key.length > 200
      || releaseKeys.has(row.release_key)) errors.push("Study exposure identity or release key is invalid");
    releaseKeys.add(String(row.release_key));
    if (!studyContextAnchorSchema.safeParse(row.context_anchor).success || !["assistant", "material_excerpt", "note", "card_answer", "history_solution"].includes(String(row.exposure_origin))
      || !["language", "math", "unknown"].includes(String(row.support_domain))) errors.push("Study exposure origin or anchor is invalid");
    const generated = timestamp(row.generated_at), released = timestamp(row.released_at), acknowledged = timestamp(row.acknowledged_at);
    if (generated === null || (row.released_at != null && released === null) || (row.acknowledged_at != null && acknowledged === null)
      || row.delivered !== (released !== null) || (released !== null && released < generated)
      || (acknowledged !== null && (released === null || acknowledged < released))) errors.push("Study exposure generated/released/acknowledged states are inconsistent");
    for (const [id, map] of [[row.session_id, sessions], [row.turn_id, turns], [row.attempt_id, attempts], [row.item_version_id, items]] as const) {
      if (id == null) continue;
      const reference = map.get(id);
      if (!reference || reference.workspace_id !== row.workspace_id || owner(reference) !== owner(row)) errors.push("Study exposure related identity is missing or foreign");
    }
    if (released !== null) {
      const revision = row.workspace_history_revision, counter = counters.get(`${row.workspace_id}/${owner(row)}`);
      if (!nonnegative(revision) || !nonnegative(counter) || revision > counter) errors.push("Study exposure workspace history counter is missing or behind");
    } else if (row.acknowledged_at != null) errors.push("Study exposure acknowledgement cannot precede release");
  }
  // A restored compile must never choose a fresh budget after its originating user turn was lost.
  for (const row of activities.values()) {
    const source = isRecord(row.create_intent) ? row.create_intent.sourceTurnId : undefined;
    if (source === undefined) continue;
    const turn = turns.get(source), conversation = conversations.get(turn?.conversation_id);
    if (!turn || turn.role !== "user" || !conversation || !sameScope(row, conversation)
      || (row.course_id ?? null) !== (conversation.course_id ?? null)) errors.push("Teaching source user turn lineage is missing or foreign");
  }
  validateDecisions(tables, errors);
  validatePredictions(tables, errors);
  validateIntentEvents(tables, errors);
}

function validateDecisions(tables: Tables, errors: string[]): void {
  const decisions = byId(tables, "opening_learning_decisions");
  const availableVersions = new Set(rows(tables, "opening_source_versions").map(row => `${row.source_id}/${row.version}`));
  for (const source of rows(tables, "opening_sources")) availableVersions.add(`${source.id}/${source.version}`);
  if (decisions.size !== rows(tables, "opening_learning_decisions").length) errors.push("Decision identities are duplicated");
  for (const row of decisions.values()) {
    const receipt = row.receipt;
    let valid = isUuid(row.id) && isUuid(row.owner_user_id) && isUuid(row.target_id) && typeof row.client_key === "string" && !!row.client_key
      && timestamp(row.created_at) !== null && isRecord(receipt);
    if (valid && isRecord(receipt)) {
      valid = strings(receipt.reasonCodes) && strings(receipt.evidenceRefs) && Array.isArray(receipt.candidates)
        && receipt.candidates.every(candidate => isRecord(candidate) && typeof candidate.action === "string" && typeof candidate.eligible === "boolean"
          && strings(candidate.reasonCodes) && strings(candidate.evidenceRefs)) && isRecord(receipt.sourceVersions)
        && Object.entries(receipt.sourceVersions).every(([source, versions]) => isUuid(source) && Array.isArray(versions) && versions.every(nonnegative))
        && Array.isArray(receipt.invalidationConditions) && receipt.invalidationConditions.every(value => ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"].includes(String(value)))
        && ["stateVersion", "goalVersion", "intentVersion", "policyVersion", "selectedAction"].every(key => typeof receipt[key] === "string" && !!receipt[key]);
      if (valid) { try { validateLearningDecision(receipt as LearningDecisionInput); } catch { valid = false; } }
      if (receipt.layer !== row.layer || receipt.targetId !== row.target_id || (receipt.parentDecisionId ?? null) !== (row.parent_decision_id ?? null)) valid = false;
    }
    if (!valid) { errors.push("Decision receipt is invalid or diverges from its row"); continue; }
    for (const [source, versions] of Object.entries((receipt as LearningDecisionInput).sourceVersions)) {
      if (versions.some(version => !availableVersions.has(`${source}/${version}`))) errors.push("Decision source version is missing");
    }
    const targets = byId(tables, row.layer === "plan" ? "opening_plan_drafts" : row.layer === "session" ? "opening_learning_sessions" : "opening_teaching_activities");
    const target = targets.get(row.target_id);
    const intentReference = /^([0-9a-f-]{36}):v([1-9][0-9]*)$/i.exec(String((receipt as LearningDecisionInput).intentVersion));
    if (intentReference) {
      const event = byId(tables, "opening_study_intent_events").get(intentReference[1]);
      const parent = decisions.get(row.parent_decision_id);
      if (!event || !sameScope(row, event) || event.version !== Number(intentReference[2])
        || (row.layer === "session" ? event.session_id !== row.target_id
          : row.layer === "activity" ? event.activity_id !== row.target_id
            || (parent?.layer === "session" && event.session_id !== parent.target_id) : true)) errors.push("Decision intent event reference is missing or mismatched");
    }
    if (!["plan", "session", "activity"].includes(String(row.layer)) || !target || !sameScope(row, target)) errors.push("Decision target is missing or foreign");
    if (row.parent_decision_id != null) {
      const parent = decisions.get(row.parent_decision_id), layer = row.layer === "activity" ? "session" : row.layer === "session" ? "plan" : null;
      if (!parent || !layer || parent.layer !== layer || !sameScope(row, parent)) errors.push("Decision parent layer or scope mismatch");
    }
  }
}

function validatePredictions(tables: Tables, errors: string[]): void {
  const attempts = byId(tables, "opening_learning_attempts"), seen = new Set<unknown>();
  for (const row of rows(tables, "opening_learning_shadow_predictions")) {
    const attempt = attempts.get(row.attempt_id), receipt = row.receipt;
    if (seen.has(row.attempt_id) || !attempt || !sameScope(row, attempt) || row.course_id !== attempt.course_id
      || row.requirement_key !== attempt.requirement_key || typeof row.state_version !== "string" || !row.state_version
      || timestamp(row.input_cutoff) === null || timestamp(row.captured_at) === null || !isRecord(receipt)
      || receipt.mode !== "shadow" || receipt.calibrated !== false || receipt.target !== "next_independent_verified_correct"
      || receipt.familyKey !== row.family_key
      || (receipt.evidenceObservationIds !== undefined && (!Array.isArray(receipt.evidenceObservationIds) || !receipt.evidenceObservationIds.every(isUuid)))
      || (receipt.predictions !== undefined && (!Array.isArray(receipt.predictions)
        || receipt.predictions.some(value => !isRecord(value) || !["classical-bkt", "pfa", "smoothed-frequency"].includes(String(value.modelId))
          || value.modelVersion !== "1" || value.calibrated !== false || typeof value.probability !== "number" || !Number.isFinite(value.probability)
          || value.probability < 0 || value.probability > 1)))) errors.push("Shadow prediction identity or receipt is invalid");
    seen.add(row.attempt_id);
  }
}


/** User declarations are historical facts: never recompute them with today's language rules. */
function validateIntentEvents(tables: Tables, errors: string[]): void {
  const sessions = byId(tables, "opening_learning_sessions"), activities = byId(tables, "opening_teaching_activities");
  const attempts = byId(tables, "opening_learning_attempts"), events = byId(tables, "opening_study_intent_events");
  const versions = new Map<unknown, number[]>(), keys = new Set<string>();
  if (events.size !== rows(tables, "opening_study_intent_events").length) errors.push("Study intent event identities are duplicated");
  for (const row of events.values()) {
    const session = sessions.get(row.session_id), activity = activities.get(row.activity_id), attempt = attempts.get(row.attempt_id);
    if (!isUuid(row.id) || !isUuid(row.owner_user_id) || !session || !activity || !sameScope(row, session) || !sameScope(row, activity)
      || session.activity_id !== row.activity_id || (row.attempt_id != null && (!attempt || !sameScope(row, attempt)
        || attempt.session_id !== row.session_id || attempt.activity_id !== row.activity_id))) errors.push("Study intent event scope or session/attempt/activity relationship is invalid");
    const key = `${row.workspace_id}/${row.owner_user_id}/${row.client_key}`;
    if (typeof row.client_key !== "string" || row.client_key.length < 8 || row.client_key.length > 200 || keys.has(key)
      || !Number.isSafeInteger(row.version) || (row.version as number) <= 0 || timestamp(row.created_at) === null) errors.push("Study intent event version or replay key is invalid");
    keys.add(key);
    versions.set(row.session_id, [...(versions.get(row.session_id) ?? []), Number(row.version)]);
    if (!isRecord(row.payload)) { errors.push("Study intent event payload is invalid"); continue; }
    const { signals, ...change } = row.payload;
    const parsed = studyIntentChangeSchema.safeParse(change);
    if (!parsed.success || row.event_kind !== parsed.data.kind || !Array.isArray(signals)
      || signals.some(signal => !["confused", "too_easy", "guessed", "copied_answer"].includes(String(signal)))
      || !studySessionIntentSchema.safeParse(row.resulting_intent).success
      || !["continue", "diagnose", "increase_challenge", "clarify_intent"].includes(String(row.action))) {
      errors.push("Study intent event payload, signals or resulting intent is invalid"); continue;
    }
    if ((parsed.data.kind === "signal" && (signals.length !== 1 || signals[0] !== parsed.data.signal))
      || (parsed.data.kind === "preference" && signals.length !== 0)
      || (row.attempt_id == null && signals.some(signal => signal === "guessed" || signal === "copied_answer"))) errors.push("Study answer-condition signals are missing their original attempt");
  }
  for (const chain of versions.values()) {
    chain.sort((a, b) => a - b);
    if (chain.some((version, index) => version !== index + 1)) errors.push("Study intent event history is incomplete or duplicated");
  }
  for (const activity of activities.values()) {
    if (!isRecord(activity.goal_json) || activity.goal_json.sessionIntentEventId == null) continue;
    const latest = events.get(activity.goal_json.sessionIntentEventId);
    if (!latest || !sameScope(activity, latest) || latest.activity_id !== activity.id
      || latest.version !== activity.goal_json.sessionIntentVersion) errors.push("Study activity intent history reference is missing or mismatched");
  }
}
