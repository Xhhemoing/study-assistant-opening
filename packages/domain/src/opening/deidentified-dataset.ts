import type { OpeningDeidentifiedDataset } from "@aistudy/contracts";
import { resolveCohortSurfacePolicy, type CohortSurfacePolicy, type CohortSurfacePolicyInput } from "../commercial-resilience";
import type { CryptoShredTombstoneReceipt } from "../resilience-canary-shredding";

type Row = Record<string, unknown>;
export type OpeningDatasetProjectionInput = {
  scope: { workspaceId: string; ownerUserId: string };
  privacyEpoch: number;
  tables: Record<string, Row[]>;
  deletedTurnIds?: string[];
};

const field = (value: unknown, key: string) => value !== null && typeof value === "object" ? (value as Row)[key] : undefined;
const canonicalId = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
const matchesId = (value: unknown, expected: string) => {
  const id = canonicalId(value);
  return id !== undefined && id === canonicalId(expected);
};
const containsId = (ids: ReadonlySet<string>, value: unknown) => {
  const id = canonicalId(value);
  return id !== undefined && ids.has(id);
};
const containsAnyId = (ids: ReadonlySet<string>, values: unknown) =>
  Array.isArray(values) && values.some(value => containsId(ids, value));
const addId = (ids: Set<string>, value: unknown) => {
  const id = canonicalId(value);
  if (id !== undefined) ids.add(id);
};

/** Only consumes owner-checked, privacy-filtered facts. No raw row is ever spread into output.
 * Lineage stays in the ephemeral input (source arrays + privacy epoch); no derived ledger is kept.
 */
export function projectOpeningDataset(input: OpeningDatasetProjectionInput, pseudonym: (kind: string, id: string) => string): OpeningDeidentifiedDataset {
  const { scope, tables } = input;
  const rows = (name: string) => tables[name] ?? [];
  const inWorkspace = (row: Row) => matchesId(row.workspace_id, scope.workspaceId);
  const owned = (row: Row) => inWorkspace(row) && matchesId(row.owner_user_id, scope.ownerUserId);
  const conversations = new Set(rows("opening_conversations").filter(owned).map(row => row.id));
  const deletedTurns = new Set<string>();
  for (const id of input.deletedTurnIds ?? []) addId(deletedTurns, id);
  const sources = new Map<string, string>();
  for (const row of rows("opening_sources")) {
    const id = canonicalId(row.id);
    if (id !== undefined && typeof row.id === "string" && inWorkspace(row)) sources.set(id, row.id);
  }
  const sourceIds = (row: Row): string[] | null => {
    if (!Array.isArray(row.source_ids)) return null;
    const ids: string[] = [];
    for (const ref of row.source_ids) {
      const id = canonicalId(ref);
      const source = id === undefined ? undefined : sources.get(id);
      if (source === undefined) return null;
      ids.push(source);
    }
    return ids;
  };
  const sourceTokens = (ids: string[]) => [...new Set(ids)].map(id => pseudonym("source", id));
  const ordered = (values: Row[], field: string) => [...values].sort((a, b) => String(a[field]).localeCompare(String(b[field])) || String(a.id).localeCompare(String(b.id)));
  const turns = ordered(rows("opening_turns").filter(row => inWorkspace(row) && conversations.has(row.conversation_id)
    && !containsId(deletedTurns, row.id) && sourceIds(row) !== null && (row.role === "user" || row.role === "assistant")), "created_at");
  const positions = new Map<unknown, number>();
  const next = (key: unknown) => { const n = (positions.get(key) ?? 0) + 1; positions.set(key, n); return n; };
  const activities = rows("opening_teaching_activities").filter(row => owned(row) && sourceIds(row) !== null
    && !containsId(deletedTurns, field(row.create_intent, "sourceTurnId")));
  const activityIds = new Set(activities.map(row => row.id));
  const observations = rows("opening_learning_observations").filter(row => owned(row)
    && Array.isArray(row.source_turn_ids) && !containsAnyId(deletedTurns, row.source_turn_ids));
  const observationIds = new Set(observations.map(row => row.id));
  const attempts = ordered(rows("opening_learning_attempts").filter(row => owned(row) && activityIds.has(row.activity_id) && sourceIds(row) !== null
    && (row.observation_id == null || observationIds.has(row.observation_id))), "started_at");
  return {
    version: 1, privacyEpoch: input.privacyEpoch,
    dialogueEvaluation: turns.map(row => ({ identity: pseudonym("turn", String(row.id)), sequence: pseudonym("dialogue", String(row.conversation_id)),
      position: next(row.conversation_id), role: row.role as "user" | "assistant", complete: row.status === "complete", sources: sourceTokens(sourceIds(row)!) })),
    answerSequences: attempts.map(row => {
      const observation = observations.find(o => o.id === row.observation_id);
      const outcome = observation?.outcome;
      return { identity: pseudonym("attempt", String(row.id)), sequence: pseudonym("activity", String(row.activity_id)), position: next(row.activity_id),
        submitted: row.submitted_at != null, outcome: outcome === "correct" || outcome === "incorrect" || outcome === "partial" ? outcome : "unknown", sources: sourceTokens(sourceIds(row)!) };
    }),
    coursePackageQuality: activities.map(row => ({ identity: pseudonym("activity", String(row.id)), generated: row.generate_status === "ready",
      sourceCount: sourceIds(row)!.length, sources: sourceTokens(sourceIds(row)!) })),
  };
}

export type PrivacyGuardedOpeningDatasetInput = OpeningDatasetProjectionInput & CohortSurfacePolicyInput & {
  readonly shreddedSourceIds?: readonly string[];
  /** The persistence layer supplies the workspace epoch at which the receipt was applied. */
  readonly tombstoneReceipts?: readonly (CryptoShredTombstoneReceipt & { readonly privacyEpoch: number })[];
};

const containsSourceRef = (ids: ReadonlySet<string>, refs: unknown) =>
  Array.isArray(refs) && refs.some(ref => containsId(ids, ref)
    || containsId(ids, field(ref, "sourceId")) || containsId(ids, field(ref, "source_id")));

type LineageKind = "session" | "activity" | "unit" | "chunk" | "item" | "observation" | "attempt" | "turn";
type LineageLink = readonly [LineageKind, unknown];

function lineageKey(kind: LineageKind, id: unknown): string | undefined {
  const key = canonicalId(id);
  return key === undefined ? undefined : `${kind}:${key}`;
}

export function projectPrivacyGuardedOpeningDataset(
  input: PrivacyGuardedOpeningDatasetInput,
  pseudonym: (kind: string, id: string) => string,
): { dataset: OpeningDeidentifiedDataset; cohortPolicy: CohortSurfacePolicy } {
  const { scope, tables } = input;
  const rows = (name: string) => tables[name] ?? [];
  const inWorkspace = (row: Row) => matchesId(row.workspace_id, scope.workspaceId);
  const shredded = new Set<string>();
  for (const id of input.shreddedSourceIds ?? []) addId(shredded, id);
  let privacyEpoch = input.privacyEpoch;
  let workspaceShredded = false;
  for (const receipt of input.tombstoneReceipts ?? []) {
    if (!matchesId(receipt.workspaceId, scope.workspaceId)) continue;
    if (!Number.isSafeInteger(receipt.privacyEpoch) || receipt.privacyEpoch < 0) throw new RangeError("Invalid tombstone privacy epoch");
    privacyEpoch = Math.max(privacyEpoch, receipt.privacyEpoch);
    for (const id of receipt.shreddedSourceIds) addId(shredded, id);
    if (receipt.target.kind === "workspace") workspaceShredded = true;
    else addId(shredded, receipt.target.sourceId);
  }

  const cohortPolicy = resolveCohortSurfacePolicy(input);
  if (workspaceShredded) return {
    cohortPolicy, dataset: { version: 1, privacyEpoch, dialogueEvaluation: [], answerSequences: [], coursePackageQuality: [] },
  };
  for (const row of rows("opening_privacy_exclusions")) {
    if (inWorkspace(row)) addId(shredded, row.source_id);
  }
  if (!shredded.size && !input.deletedTurnIds?.length) {
    return { dataset: projectOpeningDataset({ ...input, privacyEpoch }, pseudonym), cohortPolicy };
  }

  const referencesShreddedSource = (row: Row) => containsAnyId(shredded, row.source_ids)
    || containsId(shredded, row.source_id)
    || containsId(shredded, row.reference_source_id)
    || containsId(shredded, field(row.grading_work_source, "id"))
    || containsId(shredded, field(row.context_anchor, "sourceId"))
    || containsSourceRef(shredded, row.source_refs)
    || containsSourceRef(shredded, row.context_source_refs)
    || containsSourceRef(shredded, row.citations)
    || (row.source_versions !== null && typeof row.source_versions === "object"
      && Object.keys(row.source_versions).some(id => containsId(shredded, id)));

  // Index dependency edges once, then visit each excluded row once. Attempts and
  // observations can refer to each other, and activities can originate from turns.
  const dependents = new Map<string, string[]>();
  const excluded = new Set<string>();
  const exclude = (key: string | undefined) => { if (key !== undefined) excluded.add(key); };
  const index = (kind: LineageKind, table: string, links: (row: Row) => readonly LineageLink[], idField = "id") => {
    for (const row of rows(table)) {
      if (!inWorkspace(row)) continue;
      const key = lineageKey(kind, row[idField]);
      if (!key) continue;
      if (referencesShreddedSource(row)) exclude(key);
      for (const [parentKind, parentId] of links(row)) {
        const parent = lineageKey(parentKind, parentId);
        if (!parent) continue;
        const children = dependents.get(parent);
        if (children) children.push(key);
        else dependents.set(parent, [key]);
      }
    }
  };
  const anchorLinks = (anchor: unknown): LineageLink[] => [
    ["session", field(anchor, "sessionId")], ["activity", field(anchor, "activityId")],
    ["item", field(anchor, "itemVersionId")], ["attempt", field(anchor, "attemptId")],
  ];
  // Source chunks inherit workspace scope through their source ID in persisted snapshots.
  for (const row of rows("opening_source_chunks")) {
    if ((row.workspace_id == null || inWorkspace(row)) && referencesShreddedSource(row)) exclude(lineageKey("chunk", row.id));
  }
  index("unit", "opening_teaching_units", () => []);
  index("activity", "opening_teaching_activity_specs", row => [["unit", row.teaching_unit_id]], "activity_id");
  index("session", "opening_learning_sessions", row => [["activity", row.activity_id]]);
  index("activity", "opening_teaching_activities", row => [["turn", field(row.create_intent, "sourceTurnId")]]);
  index("item", "opening_learning_item_versions", row => [["activity", row.activity_id], ["chunk", row.chunk_id]]);
  index("observation", "opening_learning_observations", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["attempt", row.attempt_id],
    ...(Array.isArray(row.source_turn_ids) ? row.source_turn_ids.map((id): LineageLink => ["turn", id]) : []),
  ]);
  index("attempt", "opening_learning_attempts", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["observation", row.observation_id],
    ["turn", field(row.create_intent, "sourceTurnId")],
    ...anchorLinks(row.context_anchor),
  ]);
  index("turn", "opening_turns", row => [
    ["session", row.learning_session_id], ["activity", row.teaching_activity_id], ["attempt", row.attempt_id],
    ["chunk", row.chunk_id],
    ...anchorLinks(row.context_anchor),
  ]);
  for (const id of input.deletedTurnIds ?? []) exclude(lineageKey("turn", id));
  // Set iteration also visits newly excluded dependents.
  for (const key of excluded) for (const dependent of dependents.get(key) ?? []) excluded.add(dependent);

  const isExcluded = (kind: LineageKind, row: Row) => {
    const key = lineageKey(kind, row.id);
    return key !== undefined && excluded.has(key);
  };
  const deletedTurnIds = [...(input.deletedTurnIds ?? []), ...rows("opening_turns")
    .flatMap(row => typeof row.id === "string" && isExcluded("turn", row) ? [row.id] : [])];

  return {
    cohortPolicy,
    dataset: projectOpeningDataset({
      scope, privacyEpoch, deletedTurnIds,
      tables: {
        ...tables,
        opening_sources: rows("opening_sources").filter(row => !containsId(shredded, row.id)),
        opening_teaching_activities: rows("opening_teaching_activities").filter(row => !isExcluded("activity", row)),
        opening_learning_observations: rows("opening_learning_observations").filter(row => !isExcluded("observation", row)),
        opening_learning_attempts: rows("opening_learning_attempts").filter(row => !isExcluded("attempt", row)),
      },
    }, pseudonym),
  };
}
