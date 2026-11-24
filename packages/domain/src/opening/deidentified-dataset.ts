import type { OpeningDeidentifiedDataset } from "@aistudy/contracts";
import { resolveCohortSurfacePolicy, type CohortSurfacePolicy, type CohortSurfacePolicyInput } from "../commercial-resilience";
import type { CryptoShredTombstoneReceipt } from "../resilience-canary-shredding";
import { canSupplyBackupMemory, isRecord, isUuid, notePublicationMetadata, turnMemoryDependencyIds, turnMemoryDependencyMetadata } from "./backup-validation";

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
  readonly nowMs?: number;
  readonly shreddedSourceIds?: readonly string[];
  /** The persistence layer supplies the workspace epoch at which the receipt was applied. */
  readonly tombstoneReceipts?: readonly (CryptoShredTombstoneReceipt & { readonly privacyEpoch: number })[];
};

const containsSourceRef = (ids: ReadonlySet<string>, refs: unknown) =>
  Array.isArray(refs) && refs.some(ref => containsId(ids, ref)
    || containsId(ids, field(ref, "sourceId")) || containsId(ids, field(ref, "source_id")));

type LineageKind = "session" | "activity" | "unit" | "chunk" | "item" | "observation" | "attempt" | "turn"
  | "document" | "revision" | "problem" | "memory";
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
  const nowMs = input.nowMs ?? Date.now();
  const rows = (name: string) => tables[name] ?? [];
  const inWorkspace = (row: Row) => matchesId(row.workspace_id, scope.workspaceId);
  const inWorkspaceOrUnscoped = (row: Row) => row.workspace_id == null || inWorkspace(row);
  const workspaceIds = (name: string) => {
    const ids = new Set<string>();
    for (const row of rows(name)) if (inWorkspace(row)) addId(ids, row.id);
    return ids;
  };
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
  const excludedMemoryIds = new Set<string>();
  for (const row of rows("opening_privacy_exclusions")) {
    if (!inWorkspace(row)) continue;
    addId(shredded, row.source_id);
    addId(excludedMemoryIds, row.memory_id);
  }

  const referencesShreddedSource = (row: Row) => shredded.size > 0 && (containsAnyId(shredded, row.source_ids)
    || containsId(shredded, row.source_id)
    || containsId(shredded, row.reference_source_id)
    || containsId(shredded, field(row.reference_check, "referenceId"))
    || containsId(shredded, field(row.grading_work_source, "id"))
    || containsId(shredded, field(row.context_anchor, "sourceId"))
    || containsSourceRef(shredded, row.source_refs)
    || containsSourceRef(shredded, row.context_source_refs)
    || containsSourceRef(shredded, row.citations)
    || (row.source_versions !== null && typeof row.source_versions === "object"
      && Object.keys(row.source_versions).some(id => containsId(shredded, id))));
  const blockReferencesShreddedSource = (block: unknown) => {
    if (!shredded.size || !isRecord(block)) return false;
    const binding = field(block.content, "citationBinding");
    return referencesShreddedSource(block) || containsId(shredded, field(binding, "sourceId"))
      || containsSourceRef(shredded, field(binding, "refs"));
  };

  // Index dependency edges once, then visit each excluded row once. Attempts and
  // observations can refer to each other, and activities can originate from turns.
  const dependents = new Map<string, string[]>();
  const excluded = new Set<string>();
  const exclude = (key: string | undefined) => { if (key !== undefined) excluded.add(key); };
  const link = (parent: string | undefined, child: string | undefined) => {
    if (!parent || !child) return;
    const children = dependents.get(parent);
    if (children) children.push(child);
    else dependents.set(parent, [child]);
  };
  const sourceInventory = workspaceIds("opening_sources");
  const memoryInventory = workspaceIds("opening_memories");
  const turnInventory = workspaceIds("opening_turns");
  const chunkInventory = new Set<string>();
  // Source chunks without a workspace column inherit their scope from the source.
  for (const row of rows("opening_source_chunks")) {
    if (!inWorkspaceOrUnscoped(row)) continue;
    if (row.workspace_id != null || tables.opening_sources === undefined || containsId(sourceInventory, row.source_id)) {
      addId(chunkInventory, row.id);
    }
    if (referencesShreddedSource(row)) exclude(lineageKey("chunk", row.id));
  }
  const linkInventoryChunk = (id: string, child: string | undefined) => {
    if (tables.opening_source_chunks !== undefined && !chunkInventory.has(id)) exclude(child);
    else link(lineageKey("chunk", id), child);
  };
  const linkChunk = (value: unknown, child: string | undefined) => {
    const id = canonicalId(value);
    if (!isUuid(id)) exclude(child);
    else linkInventoryChunk(id, child);
  };
  const linkKeyframe = (value: unknown, child: string | undefined) => {
    if (value === undefined) return;
    const id = canonicalId(value);
    // Citation keyframes can use media locators as well as database UUIDs.
    if (!id || id.length > 120) exclude(child);
    else linkInventoryChunk(id, child);
  };
  const linkMemories = (ids: string[], child: string | undefined) => {
    for (const id of ids) {
      const memory = lineageKey("memory", id);
      if (!memory || (tables.opening_memories !== undefined && !containsId(memoryInventory, id))) exclude(child);
      else link(memory, child);
    }
  };
  const validSourceId = (value: unknown) => isUuid(canonicalId(value))
    && (tables.opening_sources === undefined || containsId(sourceInventory, value));
  const validVersion = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const validSourceRef = (ref: unknown): ref is Row => isRecord(ref) && validSourceId(ref.sourceId)
    && validVersion(ref.sourceVersion) && (ref.memoryOnly === undefined || typeof ref.memoryOnly === "boolean");
  const hasUnavailableSource = (row: Row) => {
    const pins = row.source_versions;
    return [row.source_id, row.reference_source_id, field(row.context_anchor, "sourceId")]
      .some(id => id != null && !validSourceId(id))
      || (row.reference_check != null && !validSourceId(field(row.reference_check, "referenceId")))
      || (pins != null && (!isRecord(pins) || Object.entries(pins).some(([id, version]) => !validSourceId(id) || !validVersion(version))))
      || (row.source_ids !== undefined && (!Array.isArray(row.source_ids) || row.source_ids.some(id =>
        canonicalId(id) === undefined || (tables.opening_sources !== undefined && !containsId(sourceInventory, id)))));
  };

  const index = (kind: LineageKind, table: string, links: (row: Row) => readonly LineageLink[], idField = "id") => {
    for (const row of rows(table)) {
      if (!inWorkspace(row)) continue;
      const key = lineageKey(kind, row[idField]);
      if (!key) continue;
      if (referencesShreddedSource(row) || hasUnavailableSource(row)) exclude(key);
      for (const [parentKind, parentId] of links(row)) {
        if (parentKind === "chunk") {
          if (parentId != null) linkChunk(parentId, key);
        }
        else link(lineageKey(parentKind, parentId), key);
      }
    }
  };
  const anchorLinks = (anchor: unknown): LineageLink[] => [
    ["session", field(anchor, "sessionId")], ["activity", field(anchor, "activityId")],
    ["item", field(anchor, "itemVersionId")], ["attempt", field(anchor, "attemptId")],
    ["chunk", field(anchor, "chunkId")],
  ];
  for (const row of rows("opening_note_provenance")) {
    if (!inWorkspaceOrUnscoped(row)) continue;
    const document = lineageKey("document", row.document_id);
    if (referencesShreddedSource(row) || !Array.isArray(row.context_source_refs)) {
      exclude(document);
      continue;
    }
    for (const ref of row.context_source_refs) {
      if (isRecord(ref) && "memoryDependencyIds" in ref) {
        const metadata = turnMemoryDependencyMetadata(ref);
        if (metadata) linkMemories(metadata.memoryDependencyIds, document);
        else exclude(document);
      } else if (!notePublicationMetadata(ref) && !validSourceRef(ref)) {
        exclude(document);
      }
    }
  }
  for (const row of rows("library_documents")) {
    if (inWorkspaceOrUnscoped(row) && (row.deleted_at != null || referencesShreddedSource(row))) {
      exclude(lineageKey("document", row.id));
    }
  }
  const indexBlock = (block: unknown, child: string | undefined) => {
    if (blockReferencesShreddedSource(block)) exclude(child);
    const content = field(block, "content");
    const cited = field(content, "citedChunkIds");
    if (cited !== undefined) {
      if (!Array.isArray(cited)) exclude(child);
      else for (const id of cited) linkChunk(id, child);
    }
    const binding = field(content, "citationBinding");
    if (binding === undefined) return;
    if (!isRecord(binding) || (binding.sourceId !== undefined && !validSourceId(binding.sourceId))) {
      exclude(child);
      return;
    }
    if (binding.chunkId !== undefined) linkChunk(binding.chunkId, child);
    if (binding.refs === undefined && binding.sourceId !== undefined) return;
    if (!Array.isArray(binding.refs)) exclude(child);
    else for (const ref of binding.refs) {
      if (!validSourceRef(ref)) exclude(child);
      else {
        linkChunk(ref.chunkId, child);
        linkKeyframe(ref.keyframeChunkId, child);
      }
    }
  };
  for (const row of rows("library_blocks")) {
    if (inWorkspaceOrUnscoped(row)) indexBlock(row, lineageKey("document", row.document_id));
  }
  for (const row of rows("library_revisions")) {
    if (!inWorkspaceOrUnscoped(row)) continue;
    const revision = lineageKey("revision", row.id);
    const document = lineageKey("document", row.document_id);
    link(document, revision);
    if (referencesShreddedSource(row)) exclude(revision);
    for (const blocks of [row.blocks, row.blocks_snapshot]) {
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        // Document exclusions already flow to the revision when its document is known.
        indexBlock(block, document ?? revision);
      }
    }
  }

  for (const id of excludedMemoryIds) exclude(lineageKey("memory", id));
  index("memory", "opening_memories", row => {
    const sourceTurnIds = row.source_turn_ids;
    const memory = lineageKey("memory", row.id);
    if (!canSupplyBackupMemory(row, nowMs) || !Array.isArray(sourceTurnIds) || sourceTurnIds.length === 0) {
      exclude(memory);
      return [];
    }
    const links: LineageLink[] = [["document", row.document_id]];
    for (const id of sourceTurnIds) {
      if (!isUuid(id) || (tables.opening_turns !== undefined && !containsId(turnInventory, id))) {
        exclude(memory);
        return [];
      }
      links.push(["turn", id]);
    }
    return links;
  });

  index("turn", "opening_turns", row => {
    const turn = lineageKey("turn", row.id);
    if (!Array.isArray(row.source_ids)) exclude(turn);
    const memoryDependencies = turnMemoryDependencyIds(row);
    const refs = row.context_source_refs;
    if (memoryDependencies === null || (!Array.isArray(refs) && row.role !== "user")) exclude(turn);
    else {
      linkMemories(memoryDependencies, turn);
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          if (!(isRecord(ref) && "memoryDependencyIds" in ref) && !validSourceRef(ref)) exclude(turn);
        }
      }
    }
    const citations = row.citations;
    if (citations !== undefined) {
      if (!Array.isArray(citations)) exclude(turn);
      else for (const citation of citations) {
        if (!validSourceRef(citation)) exclude(turn);
        else {
          linkChunk(citation.chunkId, turn);
          linkKeyframe(citation.keyframeChunkId, turn);
        }
      }
    }
    const snapshot = row.help_input_snapshot;
    const userTurnId = field(snapshot, "userTurnId");
    const assistantTurnId = field(snapshot, "assistantTurnId") ?? field(snapshot, "assistant_turn_id");
    link(lineageKey("turn", userTurnId ?? row.id), lineageKey("turn", assistantTurnId));
    return [
      ["session", row.learning_session_id], ["activity", row.teaching_activity_id], ["attempt", row.attempt_id],
      ["chunk", row.chunk_id], ["turn", row.role === "assistant" ? userTurnId : undefined],
      ...anchorLinks(row.context_anchor),
    ];
  });
  for (const id of input.deletedTurnIds ?? []) exclude(lineageKey("turn", id));

  const problemLinks = (row: Row): LineageLink[] => [
    ["problem", row.problem_id], ["revision", row.teaching_revision_id],
  ];
  index("unit", "opening_teaching_units", row => [["document", row.document_id]]);
  index("activity", "opening_teaching_activity_specs", row => {
    const activity = lineageKey("activity", row.activity_id);
    const refs = row.source_refs;
    if (refs !== undefined) {
      if (!Array.isArray(refs)) exclude(activity);
      else for (const ref of refs) {
        if (!isRecord(ref) || !validSourceId(ref.sourceId)
          || (ref.version != null && !(validVersion(ref.version)
            || typeof ref.version === "string" && /^(0|[1-9]\d*)$/.test(ref.version) && validVersion(Number(ref.version))))
          || (ref.sourceVersion !== undefined && !validVersion(ref.sourceVersion))
          || (ref.page != null && (!validVersion(ref.page) || ref.page === 0))) exclude(activity);
        else {
          if (ref.chunkId != null) linkChunk(ref.chunkId, activity);
          linkKeyframe(ref.keyframeChunkId, activity);
        }
      }
    }
    return [["unit", row.teaching_unit_id], ["document", row.document_id]];
  }, "activity_id");
  index("session", "opening_learning_sessions", row => [["activity", row.activity_id]]);
  index("activity", "opening_teaching_activities", row => [["turn", field(row.create_intent, "sourceTurnId")]]);
  index("problem", "opening_problem_refs", row => [
    ["session", row.session_id], ["chunk", row.chunk_id], ["revision", row.teaching_revision_id],
  ], "problem_id");
  index("item", "opening_learning_item_versions", row => [["activity", row.activity_id], ["chunk", row.chunk_id], ...problemLinks(row)]);
  index("observation", "opening_learning_observations", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["attempt", row.attempt_id],
    ["observation", row.root_observation_id], ["observation", row.revises_observation_id], ["observation", row.effective_head_id],
    ...problemLinks(row),
    ...(Array.isArray(row.source_turn_ids) ? row.source_turn_ids.map((id): LineageLink => ["turn", id]) : []),
  ]);
  index("attempt", "opening_learning_attempts", row => [
    ["session", row.session_id], ["activity", row.activity_id], ["item", row.item_version_id], ["observation", row.observation_id],
    ["turn", field(row.create_intent, "sourceTurnId")],
    ...problemLinks(row),
    ...anchorLinks(row.context_anchor),
  ]);
  for (const row of rows("opening_tutor_jobs")) {
    if (inWorkspaceOrUnscoped(row)) link(lineageKey("turn", row.user_turn_id), lineageKey("turn", row.assistant_turn_id));
  }
  if (!shredded.size && !excluded.size) {
    return { dataset: projectOpeningDataset({ ...input, privacyEpoch }, pseudonym), cohortPolicy };
  }
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
