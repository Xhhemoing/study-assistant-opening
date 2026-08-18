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
    tags: "tags", archived: "archived", content_version: "contentVersion",
    paused_until: "pausedUntil", maintain_until: "maintainUntil",
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
};

export async function loadExistingIds(
  sql: Sql,
  packed: NativeBackupPackage,
): Promise<ExistingBackupIds> {
  const existing: ExistingBackupIds = {};
  for (const collection of RESTORE_TOPOLOGY) {
    const ids = asRecords(packed.records[collection]).map((row) => row.id);
    if (ids.length === 0) {
      existing[collection] = [];
      continue;
    }
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM ${sql(COLLECTION_TABLES[collection])} WHERE id IN ${sql(ids)}
    `;
    existing[collection] = rows.map((row) => row.id);
  }
  return existing;
}

export async function applyRestorePlan(tx: Sql, plan: NativeRestorePlan): Promise<void> {
  for (const step of plan.steps) {
    await insertRows(tx, COLLECTION_TABLES[step.collection], step.records, COLUMNS[step.collection]);
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
}

async function insertRows(
  tx: Sql,
  table: string,
  rows: NativeBackupRecord[],
  columns: Record<string, string>,
): Promise<void> {
  for (const row of rows) {
    const payload = pickColumns(row, columns);
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
