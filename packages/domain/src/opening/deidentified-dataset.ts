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
/** Only consumes owner-checked, privacy-filtered facts. No raw row is ever spread into output.
 * Lineage stays in the ephemeral input (source arrays + privacy epoch); no derived ledger is kept.
 */
export function projectOpeningDataset(input: OpeningDatasetProjectionInput, pseudonym: (kind: string, id: string) => string): OpeningDeidentifiedDataset {
  const { scope, tables } = input;
  const rows = (name: string) => tables[name] ?? [];
  const owned = (row: Row) => row.workspace_id === scope.workspaceId && row.owner_user_id === scope.ownerUserId;
  const conversations = new Set(rows("opening_conversations").filter(owned).map(row => row.id));
  const deletedTurns = new Set(input.deletedTurnIds ?? []);
  const sources = new Set(rows("opening_sources").filter(row => row.workspace_id === scope.workspaceId).map(row => row.id));
  const sourceIds = (row: Row): string[] | null => Array.isArray(row.source_ids) && row.source_ids.every(id => typeof id === "string" && sources.has(id)) ? row.source_ids as string[] : null;
  const sourceTokens = (ids: string[]) => [...new Set(ids)].map(id => pseudonym("source", id));
  const ordered = (values: Row[], field: string) => [...values].sort((a, b) => String(a[field]).localeCompare(String(b[field])) || String(a.id).localeCompare(String(b.id)));
  const turns = ordered(rows("opening_turns").filter(row => row.workspace_id === scope.workspaceId && conversations.has(row.conversation_id)
    && !deletedTurns.has(String(row.id)) && sourceIds(row) !== null && (row.role === "user" || row.role === "assistant")), "created_at");
  const positions = new Map<unknown, number>();
  const next = (key: unknown) => { const n = (positions.get(key) ?? 0) + 1; positions.set(key, n); return n; };
  const activities = rows("opening_teaching_activities").filter(row => owned(row) && sourceIds(row) !== null
    && !(typeof row.create_intent === "object" && row.create_intent !== null && deletedTurns.has(String((row.create_intent as Row).sourceTurnId))));
  const activityIds = new Set(activities.map(row => row.id));
  const observations = rows("opening_learning_observations").filter(row => owned(row)
    && Array.isArray(row.source_turn_ids) && !row.source_turn_ids.some(id => deletedTurns.has(String(id))));
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

const field = (value: unknown, key: string) => value !== null && typeof value === "object" ? (value as Row)[key] : undefined;
const containsId = (ids: ReadonlySet<string>, id: unknown) => typeof id === "string" && ids.has(id.toLowerCase());
const containsAnyId = (ids: ReadonlySet<string>, values: unknown) =>
  Array.isArray(values) && values.some(value => containsId(ids, value));
const containsSourceRef = (ids: ReadonlySet<string>, refs: unknown) =>
  Array.isArray(refs) && refs.some(ref => containsId(ids, field(ref, "sourceId")));

type LineageKind = "session" | "activity" | "item" | "observation" | "attempt" | "turn";
type LineageLink = readonly [LineageKind, unknown];

function lineageKey(kind: LineageKind, id: unknown): string | undefined {
  return typeof id === "string" ? `${kind}:${id.toLowerCase()}` : undefined;
}

export function projectPrivacyGuardedOpeningDataset(
  input: PrivacyGuardedOpeningDatasetInput,
  pseudonym: (kind: string, id: string) => string,
): { dataset: OpeningDeidentifiedDataset; cohortPolicy: CohortSurfacePolicy } {
  const { scope, tables } = input;
  const shredded = new Set((input.shreddedSourceIds ?? []).map(id => id.toLowerCase()));
  let privacyEpoch = input.privacyEpoch;
  let workspaceShredded = false;
  for (const receipt of input.tombstoneReceipts ?? []) {
    if (receipt.workspaceId !== scope.workspaceId) continue;
    if (!Number.isSafeInteger(receipt.privacyEpoch) || receipt.privacyEpoch < 0) throw new RangeError("Invalid tombstone privacy epoch");
    privacyEpoch = Math.max(privacyEpoch, receipt.privacyEpoch);
    for (const id of receipt.shreddedSourceIds) shredded.add(id.toLowerCase());
    if (receipt.target.kind === "workspace") workspaceShredded = true;
    else shredded.add(receipt.target.sourceId.toLowerCase());
  }

  const cohortPolicy = resolveCohortSurfacePolicy(input);
  if (workspaceShredded) return {
    cohortPolicy, dataset: { version: 1, privacyEpoch, dialogueEvaluation: [], answerSequences: [], coursePackageQuality: [] },
  };
  if (!shredded.size && !input.deletedTurnIds?.length) {
    return { dataset: projectOpeningDataset({ ...input, privacyEpoch }, pseudonym), cohortPolicy };
  }

  const rows = (name: string) => tables[name] ?? [];
  const referencesShreddedSource = (row: Row) => containsAnyId(shredded, row.source_ids)
    || containsId(shredded, row.source_id)
    || containsId(shredded, row.reference_source_id)
    || containsId(shredded, field(row.grading_work_source, "id"))
    || containsId(shredded, field(row.context_anchor, "sourceId"))
    || containsSourceRef(shredded, row.context_source_refs)
    || containsSourceRef(shredded, row.citations)
    || (row.source_versions !== null && typeof row.source_versions === "object"
      && Object.keys(row.source_versions).some(id => containsId(shredded, id)));

  // Index dependency edges once, then visit each excluded row once. Attempts and
  // observations can refer to each other, and activities can originate from turns.
  const dependents = new Map<string, string[]>();
  const excluded = new Set<string>();
  const exclude = (key: string | undefined) => { if (key !== undefined) excluded.add(key); };
  const index = (kind: LineageKind, table: string, links: (row: Row) => readonly LineageLink[]) => {
    for (const row of rows(table)) {
      if (row.workspace_id !== scope.workspaceId) continue;
      const key = lineageKey(kind, row.id);
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
  index("session", "opening_learning_sessions", row => [["activity", row.activity_id]]);
  index("activity", "opening_teaching_activities", row => [["turn", field(row.create_intent, "sourceTurnId")]]);
  index("item", "opening_learning_item_versions", row => [["activity", row.activity_id]]);
  index("observation", "opening_learning_observations", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["attempt", row.attempt_id],
    ...(Array.isArray(row.source_turn_ids) ? row.source_turn_ids.map((id): LineageLink => ["turn", id]) : []),
  ]);
  index("attempt", "opening_learning_attempts", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["observation", row.observation_id],
    ...anchorLinks(row.context_anchor),
  ]);
  index("turn", "opening_turns", row => [
    ["session", row.learning_session_id], ["activity", row.teaching_activity_id], ["attempt", row.attempt_id],
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
