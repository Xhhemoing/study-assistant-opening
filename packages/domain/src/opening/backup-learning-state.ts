import { isRecord, isUuid } from "./backup-validation";
import { openingAiSettingsSchema } from "@aistudy/contracts";

type Row = Record<string, unknown>;
export type OpeningRestoreLearningState = {
  /** Owner-scoped target rows, read by the executor; null means no preference row exists. */
  workspacePreferences: Row | null;
  courses: readonly Row[];
};
export const LEARNING_STATE_TABLES = ["workspace_preferences", "courses", "course_asset_memberships"] as const;
const preferences = ["assessment_enabled", "retest_suggestions_enabled", "automatic_reminders_enabled"] as const;
const activations = ["retest_suggestions_enabled_at", "automatic_reminders_enabled_at"] as const;
// Preserve PostgreSQL microseconds; Date values are legacy millisecond snapshots.
const timestamp = (value: unknown): bigint | null => {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? BigInt(time) * 1000n : null;
  }
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return null;
  const time = Date.parse(`${parts[1]}${parts[3]}`);
  return Number.isFinite(time) ? BigInt(time) * 1000n + BigInt((parts[2] ?? "").padEnd(6, "0")) : null;
};
function validState(row: Row): boolean {
  return preferences.every(key => row[key] === null || typeof row[key] === "boolean")
    && activations.every(key => row[key] === null || timestamp(row[key]) !== null);
}

/** Opening carries source memberships only; native library assets use their own backup. */
export function validateBackupLearningState(tables: Record<string, Row[]>, errors: string[]): void {
  const accounts = tables.workspace_preferences ?? [];
  if (accounts.length > 1) errors.push("workspace preferences are duplicated");
  for (const row of accounts) {
    if (row.ai_settings != null && !openingAiSettingsSchema.safeParse(row.ai_settings).success) {
      errors.push("workspace AI settings are invalid");
    }
    if (!validState(row) || (row.default_entry != null && !["learn", "explore", "library"].includes(String(row.default_entry)))) {
      errors.push("workspace learning preferences are invalid or incomplete");
    }
  }
  const courses = new Set<string>(), slugs = new Set<string>();
  for (const row of tables.courses ?? []) {
    if (!isUuid(row.id) || !validState(row) || (row.archived_at !== null && timestamp(row.archived_at) === null)
      || typeof row.title !== "string" || typeof row.slug !== "string" || !row.slug
      || !Number.isSafeInteger(row.schema_version) || (row.schema_version as number) < 1) {
      errors.push("course state is invalid or incomplete");
      continue;
    }
    if (courses.has(row.id.toLowerCase()) || slugs.has(row.slug)) errors.push("course identity or slug is duplicated");
    courses.add(row.id.toLowerCase()); slugs.add(row.slug);
  }
  const sources = new Set((tables.opening_sources ?? []).filter(row => isUuid(row.id)).map(row => (row.id as string).toLowerCase()));
  const membershipIds = new Set<string>(), memberships = new Set<string>();
  for (const row of tables.course_asset_memberships ?? []) {
    if (row.asset_type !== "source") errors.push("Opening backup only supports source course memberships");
    if (!isUuid(row.course_id) || !courses.has(row.course_id.toLowerCase())) errors.push("course membership course is not included");
    if (!isUuid(row.asset_id) || !sources.has(row.asset_id.toLowerCase())) errors.push("course membership source is not included");
    if (!isUuid(row.id) || !["core", "optional", "reference", "archive"].includes(String(row.role))
      || !["private", "course", "public"].includes(String(row.visibility)) || !Number.isSafeInteger(row.sort_order)) {
      errors.push("course membership metadata is invalid");
    }
    const id = String(row.id).toLowerCase(), key = `${String(row.course_id).toLowerCase()}/${String(row.asset_id).toLowerCase()}`;
    if (membershipIds.has(id) || memberships.has(key)) errors.push("course membership is duplicated");
    membershipIds.add(id); memberships.add(key);
  }
}

function stateConflicts(incoming: Row, current: Row, course: boolean, errors: string[]): void {
  for (const key of preferences) {
    // Account NULL is disabled; course NULL inherits. Explicit false remains protected in both.
    if ((current[key] === false && incoming[key] !== false)
      || (!course && current[key] === null && incoming[key] === true)) {
      errors.push(`restore would overwrite a closed learning preference: ${key}`);
    }
  }
  if (course && current.archived_at != null && incoming.archived_at === null) errors.push("restore would reopen an archived course");
  for (const key of activations) {
    const enabled = key === "retest_suggestions_enabled_at" ? "retest_suggestions_enabled" : "automatic_reminders_enabled";
    const active = course ? incoming.archived_at === null && incoming.assessment_enabled !== false && incoming[enabled] !== false
      : incoming.assessment_enabled === true && incoming[enabled] === true;
    const before = timestamp(current[key]), after = timestamp(incoming[key]);
    if (active && before !== null && (after === null || after < before)) errors.push(`restore would rewind a learning activation time: ${key}`);
  }
}

/** Reject conflicting rows; the plan never silently rewrites the archive or turns unknown choices on. */
export function learningStateRestoreErrors(
  tables: Record<string, unknown[]>, workspaceId: string, current: OpeningRestoreLearningState | undefined,
): string[] {
  const incomingAccounts = tables.workspace_preferences as Row[] | undefined;
  const incomingCourses = tables.courses as Row[] | undefined;
  if (!incomingAccounts?.length && !incomingCourses?.length) return [];
  if (!isRecord(current) || !(current.workspacePreferences === null || isRecord(current.workspacePreferences))
    || !Array.isArray(current.courses) || !current.courses.every(isRecord)) return ["current learning state preflight is required"];
  const rows = [...(current.workspacePreferences ? [current.workspacePreferences] : []), ...current.courses];
  if (rows.some(row => !isUuid(row.workspace_id) || row.workspace_id.toLowerCase() !== workspaceId.toLowerCase())) {
    return ["current learning state contains a foreign or missing workspace"];
  }
  const errors: string[] = [];
  validateBackupLearningState({ workspace_preferences: current.workspacePreferences ? [current.workspacePreferences] : [], courses: current.courses }, errors);
  if (errors.length) return errors.map(error => `current learning state: ${error}`);
  if (incomingAccounts?.[0] && current.workspacePreferences) stateConflicts(incomingAccounts[0], current.workspacePreferences, false, errors);
  const courses = new Map(current.courses.map(row => [String(row.id).toLowerCase(), row]));
  for (const row of incomingCourses ?? []) {
    const existing = courses.get(String(row.id).toLowerCase());
    if (existing) stateConflicts(row, existing, true, errors);
  }
  return errors;
}
