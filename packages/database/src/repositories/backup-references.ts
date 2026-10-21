import { reviewStateSchema, uuidSchema } from "@aistudy/contracts";
import type { NativeBackupRecord, NativeRestorePlan } from "@aistudy/domain";
import type { Sql } from "postgres";
import { COLLECTION_TABLES, asRecords } from "./backup-map";
import { BackupRestoreError } from "./backup-types";

const ASSET_TABLES: Record<string, string> = {
  document: "library_documents", block: "library_blocks", card: "cards",
  source: "opening_sources", "practice-item": "practice_items",
};

/** Validate the whole graph before writing any row, including forward references. */
export async function assertRestoreReferences(tx: Sql, plan: NativeRestorePlan): Promise<void> {
  const workspaceId = plan.records.workspaceId;
  const staged = new Map<string, Set<string>>();
  const references = new Map<string, Set<string>>();
  const historical = new Map<string, Set<string>>();
  const addId = (table: string, id: unknown) => {
    if (!uuidSchema.safeParse(id).success) invalid();
    const ids = staged.get(table) ?? new Set<string>();
    if (ids.has(String(id))) invalid();
    ids.add(String(id)); staged.set(table, ids);
  };
  const ref = (table: string | undefined, id: unknown, optional = false, history = false) => {
    if (id == null && optional) return;
    if (!table || !uuidSchema.safeParse(id).success) invalid();
    const target = history ? historical : references;
    const ids = target.get(table!) ?? new Set<string>();
    ids.add(String(id)); target.set(table!, ids);
  };
  const nested = (record: NativeBackupRecord, key: string): NativeBackupRecord[] => {
    if (record[key] === undefined) return [];
    if (!Array.isArray(record[key])) invalid();
    const rows = asRecords(record[key]);
    if (rows.length !== (record[key] as unknown[]).length) invalid();
    return rows;
  };

  for (const step of plan.steps) for (const row of step.records) {
    if (row.workspaceId !== workspaceId) invalid();
    addId(COLLECTION_TABLES[step.collection], row.id);
    if (step.collection === "explorations") {
      for (const child of nested(row, "branches")) {
        if (child.explorationId !== row.id) invalid();
        addId("exploration_branches", child.id);
        ref("exploration_branches", child.parentBranchId, true);
      }
      for (const child of nested(row, "blocks")) {
        if (child.explorationId !== row.id) invalid();
        addId("exploration_blocks", child.id);
        ref("exploration_branches", child.branchId);
      }
    }
    if (step.collection === "promotions") for (const child of nested(row, "targets")) {
      if (child.promotionId !== row.id || child.explorationId !== row.explorationId) invalid();
      addId("promotion_targets", child.id);
      ref("exploration_blocks", child.sourceTurnId, true, true);
    }
    if (step.collection === "cards") for (const child of nested(row, "reviewStates")) {
      if (child.cardId !== row.id) invalid();
      if (!reviewStateSchema.safeParse({ ...child, fsrs: child.fsrsState }).success) {
        throw new BackupRestoreError("VALIDATION", "card review state is invalid");
      }
    }
  }

  for (const step of plan.steps) for (const row of step.records) {
    switch (step.collection) {
      case "blocks": case "revisions": ref("library_documents", row.documentId); break;
      case "relations":
        ref(ASSET_TABLES[String(row.fromType)], row.fromId, false, true);
        ref(ASSET_TABLES[String(row.toType)], row.toId, false, true); break;
      case "memberships":
        ref("courses", row.courseId);
        // Artifact is a reserved opaque identity; there is no artifact table.
        if (row.assetType === "artifact") {
          if (!uuidSchema.safeParse(row.assetId).success) invalid();
        } else ref(ASSET_TABLES[String(row.assetType)], row.assetId, false, true);
        break;
      case "goals": ref("courses", row.courseId); break;
      case "windows": ref("course_goals", row.goalId); break;
      case "explorations":
        ref("courses", row.courseId, true); ref("course_goals", row.goalId, true); break;
      case "promotions":
        ref("explorations", row.explorationId);
        ref("exploration_blocks", row.sourceTurnId, true, true);
        if (row.targetId != null) ref(row.targetType === "document" ? "library_documents" : "promotion_targets", row.targetId);
        break;
      case "cards":
        ref("courses", row.courseId, true); ref("library_documents", row.sourceDocumentId, true);
        ref("syllabus_nodes", row.syllabusPointId, true, true); break;
      case "events":
        ref("learning_events", row.correctsEventId, true);
        ref("syllabus_nodes", row.syllabusPointId, true, true);
        // Corrections can retain an optional historical content id. The target
        // event is the authoritative, workspace-scoped relationship.
        if (row.type === "review") ref("cards", row.contentId, false, true);
        if (row.type === "attempt") ref("practice_items", row.contentId, false, true);
        break;
    }
  }
  for (const [table, ids] of references) {
    const unresolved = [...ids].filter(id => !staged.get(table)?.has(id));
    if (!unresolved.length) continue;
    const rows = await tx<{ id: string }[]>`SELECT id FROM ${tx(table)}
      WHERE workspace_id=${workspaceId} AND id IN ${tx(unresolved)} FOR SHARE`;
    if (new Set(rows.map(row => row.id)).size !== unresolved.length) invalid();
  }
  // The native format deliberately retains broken relations and historical
  // practice/syllabus ids without exporting the referenced content. Missing ids
  // stay inert; an id resolving to a live foreign row must still be rejected.
  for (const [table, ids] of historical) {
    const unresolved = [...ids].filter(id => !staged.get(table)?.has(id));
    if (!unresolved.length) continue;
    const foreign = await tx`SELECT id FROM ${tx(table)}
      WHERE workspace_id<>${workspaceId} AND id IN ${tx(unresolved)} FOR SHARE`;
    if (foreign.length) invalid();
  }
}

function invalid(): never {
  // Identical response for absent and foreign references; never disclose ids.
  throw new BackupRestoreError("VALIDATION", "Backup contains invalid or unavailable workspace references");
}
