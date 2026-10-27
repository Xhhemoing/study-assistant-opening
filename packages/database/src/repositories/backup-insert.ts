import { uuidSchema } from "@aistudy/contracts";
import { BackupRestoreError } from "./backup-types";
import { readNoteBackupProvenance } from "./native-note-privacy";
import { restoreNativeLearningLinks } from "./native-learning-links";
import type { Sql } from "postgres";
import type { NativeBackupPackage } from "@aistudy/contracts";
import {
  RESTORE_TOPOLOGY,
  type ExistingBackupIds,
  type NativeBackupRecord,
  type NativeRestorePlan,
  type RestoreCollection,
} from "@aistudy/domain";
import { asRecords, COLLECTION_TABLES, pickColumns } from "./backup-map";
import { assertRestoreReferences } from "./backup-references";

const COLUMNS: Record<RestoreCollection, Record<string, string>> = {
  courses: {
    id: "id", workspace_id: "workspaceId", title: "title", slug: "slug",
    description: "description", schema_version: "schemaVersion",
    created_at: "createdAt", updated_at: "updatedAt", archived_at: "archivedAt",
  },
  documents: {
    id: "id", workspace_id: "workspaceId", title: "title", lifecycle: "lifecycle",
    schema_version: "schemaVersion", current_revision_number: "currentRevisionNumber",
    created_at: "createdAt", updated_at: "updatedAt", deleted_at: "deletedAt",
  },
  blocks: {
    id: "id", workspace_id: "workspaceId", document_id: "documentId", type: "type",
    position: "position", content: "content", created_at: "createdAt", updated_at: "updatedAt",
  },
  revisions: {
    id: "id", workspace_id: "workspaceId", document_id: "documentId",
    revision_number: "revisionNumber", parent_revision_number: "parentRevisionNumber",
    title: "title", lifecycle: "lifecycle", reason: "reason", blocks: "blocks",
    created_at: "createdAt",
  },
  relations: {
    id: "id", workspace_id: "workspaceId", from_type: "fromType", from_id: "fromId",
    to_type: "toType", to_id: "toId", relation_type: "relationType", source: "source",
    created_at: "createdAt",
  },
  memberships: {
    id: "id", workspace_id: "workspaceId", course_id: "courseId", asset_type: "assetType",
    asset_id: "assetId", role: "role", sort_order: "sortOrder", visibility: "visibility",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  goals: {
    id: "id", workspace_id: "workspaceId", course_id: "courseId", kind: "kind", title: "title",
    priority: "priority", intensity: "intensity", abilities: "abilities",
    strategy_version: "strategyVersion", active: "active", exam_date: "examDate",
    target_date: "targetDate", revision: "revision", weekly_minutes: "weeklyMinutes", learning_mode: "learningMode",
    success_criteria: "successCriteria", lifecycle: "lifecycle", maintenance_interval_days: "maintenanceIntervalDays",
    milestones: "milestones", definition_history: "definitionHistory", client_key: "clientKey", create_intent: "createIntent",
    user_override: "userOverride", archived_at: "archivedAt",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  windows: {
    id: "id", workspace_id: "workspaceId", goal_id: "goalId", phase: "phase",
    starts_at: "startsAt", ends_at: "endsAt", modifier: "modifier",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  explorations: {
    id: "id", workspace_id: "workspaceId", owner_user_id: "ownerUserId", course_id: "courseId",
    goal_id: "goalId", title: "title", status: "status", closed_at: "closedAt",
    created_at: "createdAt", updated_at: "updatedAt",
  },
  promotions: {
    id: "id", workspace_id: "workspaceId", exploration_id: "explorationId",
    source_turn_id: "sourceTurnId", kind: "kind", title: "title", body: "body",
    status: "status", target_type: "targetType", target_id: "targetId",
    reviewed_at: "reviewedAt", created_at: "createdAt", updated_at: "updatedAt",
  },
  cards: {
    id: "id", workspace_id: "workspaceId", owner_user_id: "ownerUserId", front: "front",
    back: "back", source_document_id: "sourceDocumentId", syllabus_point_id: "syllabusPointId",
    source_ids: "sourceIds", tags: "tags", course_id: "courseId", skill_label: "skillLabel", archived: "archived", content_version: "contentVersion",
    paused_until: "pausedUntil", maintain_until: "maintainUntil",
    origin_observation_root_id: "originObservationRootId", auto_paused: "autoPaused",
    exclude_from_assessment: "excludeFromAssessment", created_at: "createdAt",
    updated_at: "updatedAt",
  },
  events: {
    id: "id", workspace_id: "workspaceId", owner_user_id: "ownerUserId", type: "type",
    schema_version: "schemaVersion", idempotency_key: "idempotencyKey",
    occurred_at: "occurredAt", created_at: "createdAt", content_id: "contentId",
    content_version: "contentVersion", syllabus_point_id: "syllabusPointId",
    corrects_event_id: "correctsEventId", payload: "payload",
  },
};

const BRANCH_COLS = {
  id: "id", workspace_id: "workspaceId", exploration_id: "explorationId",
  parent_branch_id: "parentBranchId", title: "title", created_at: "createdAt",
  updated_at: "updatedAt",
};
const EXPLORATION_BLOCK_COLS = {
  id: "id", workspace_id: "workspaceId", exploration_id: "explorationId",
  branch_id: "branchId", kind: "kind", content: "content", position: "position",
  created_at: "createdAt", updated_at: "updatedAt",
};
const TARGET_COLS = {
  id: "id", workspace_id: "workspaceId", promotion_id: "promotionId",
  exploration_id: "explorationId", source_turn_id: "sourceTurnId", kind: "kind",
  title: "title", body: "body", created_at: "createdAt",
};
const STATE_COLS = {
  owner_user_id: "ownerUserId", card_id: "cardId", workspace_id: "workspaceId",
  ease: "ease", interval_days: "intervalDays", due_at: "dueAt", reps: "reps",
  lapses: "lapses", last_grade: "lastGrade", updated_at: "updatedAt",
  srs_version: "srsVersion", fsrs_state: "fsrsState",
};

export async function loadExistingIds(
  sql: Sql,
  packed: NativeBackupPackage,
  workspaceId: string,
): Promise<ExistingBackupIds> {
  const existing: ExistingBackupIds = {};
  for (const collection of RESTORE_TOPOLOGY) {
    const records = packed.records[collection];
    const ids = asRecords(records).map((row) => row.id);
    if (ids.length !== records.length || ids.some(id => !uuidSchema.safeParse(id).success)
      || new Set(ids).size !== ids.length) {
      throw new BackupRestoreError("VALIDATION", "Backup contains invalid or duplicate record identities");
    }
    if (ids.length === 0) {
      existing[collection] = [];
      continue;
    }
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM ${sql(COLLECTION_TABLES[collection])}
      WHERE workspace_id=${workspaceId} AND id IN ${sql(ids)}
    `;
    existing[collection] = rows.map((row) => row.id);
  }
  return existing;
}

export async function applyRestorePlan(tx: Sql, plan: NativeRestorePlan): Promise<void> {
  await assertRestoreReferences(tx, plan);
  for (const step of plan.steps) {
    if (step.collection === "cards") {
      for (const card of step.records) {
        if (card.courseId != null) {
          if (!uuidSchema.safeParse(card.courseId).success) throw new BackupRestoreError("VALIDATION", "card course is invalid");
          const courses = await tx`SELECT id FROM courses WHERE id=${String(card.courseId)} AND workspace_id=${String(card.workspaceId)} FOR SHARE`;
          if (!courses.length) throw new BackupRestoreError("VALIDATION", "card course is outside target workspace");
        }
        if (card.sourceDocumentId != null) {
          if (!uuidSchema.safeParse(card.sourceDocumentId).success) throw new BackupRestoreError("VALIDATION", "card note is invalid");
          const notes = await tx`SELECT id FROM library_documents WHERE id=${String(card.sourceDocumentId)} AND workspace_id=${String(card.workspaceId)} FOR SHARE`;
          if (!notes.length) throw new BackupRestoreError("VALIDATION", "card note is outside target workspace");
        }
      }
    }
    await insertRows(tx, COLLECTION_TABLES[step.collection], step.records, COLUMNS[step.collection]);
    if (step.collection === "goals") {
      for (const goal of step.records) for (const courseId of new Set((goal.courseIds ?? [goal.courseId]) as string[])) {
        await tx`INSERT INTO course_goal_links(workspace_id,goal_id,course_id) VALUES(${String(goal.workspaceId)},${goal.id},${courseId})`;
      }
    }
    if (step.collection === "documents") {
      for (const record of step.records) {
        const provenance = readNoteBackupProvenance(record, false);
        if (provenance) await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
          VALUES(${record.id},${String(record.workspaceId)},${tx.json(provenance.contextSourceRefs)})`;
      }
    }
    if (step.collection === "explorations") {
      for (const record of step.records) {
        await insertRows(tx, "exploration_branches", childRows(record, "branches"), BRANCH_COLS);
        await insertRows(tx, "exploration_blocks", childRows(record, "blocks"), EXPLORATION_BLOCK_COLS);
      }
    }
    if (step.collection === "promotions") {
      for (const record of step.records) {
        await insertRows(tx, "promotion_targets", childRows(record, "targets"), TARGET_COLS);
      }
    }
    if (step.collection === "cards") {
      for (const record of step.records) {
        await insertRows(tx, "card_review_states", childRows(record, "reviewStates"), STATE_COLS);
      }
    }
  }
  await restoreNativeLearningLinks(tx, plan.steps.filter(step => step.collection === "documents").flatMap(step => step.records));
}

async function insertRows(
  tx: Sql,
  table: string,
  rows: NativeBackupRecord[],
  columns: Record<string, string>,
): Promise<void> {
  for (const row of rows) {
    const payload = pickColumns(row, columns);
    if (table === "course_goals") {
      for (const key of ["abilities", "milestones", "definition_history", "create_intent", "user_override"]) {
        if (payload[key] != null) payload[key] = tx.json(payload[key] as never);
      }
      // Restoring a definition does not reauthorize future automatic learning.
      if (!["archived", "stopped"].includes(String(payload.lifecycle))) payload.lifecycle = "paused";
      payload.active = false;
    }
    if (Object.keys(payload).length === 0) continue;
    await tx`INSERT INTO ${tx(table)} ${tx(payload)}`;
  }
}

function childRows(parent: NativeBackupRecord, key: string): NativeBackupRecord[] {
  return asRecords(parent[key]).map((child) => ({
    ...child,
    workspaceId: parent.workspaceId,
    ...(typeof parent.ownerUserId === "string" ? { ownerUserId: parent.ownerUserId } : {}),
  }));
}
