import type { Sql } from "postgres";
import {
  isoDateTimeSchema,
  plannedBlockSchema,
  scopeSchema,
  timeBlockSchema,
  uuidSchema,
  type PlannedBlock,
  type Scope,
  type TimeBlock,
} from "@aistudy/contracts";

// Per collection, including invalid rows selected for validation. Never return a
// truncated constraint set: that could manufacture time or schedule a task twice.
const MAX_CONSTRAINTS = 4000;
const validInterval = (block: { start: string; end: string }) => {
  const start = Date.parse(block.start), end = Date.parse(block.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
};
const windowSchema = timeBlockSchema.pick({ start: true, end: true })
  .refine(validInterval, "window must end after it starts");
const acceptedSchema = plannedBlockSchema
  .refine(validInterval, "accepted block must end after it starts");
const lockedSchema = timeBlockSchema
  .refine(block => block.kind === "locked", "only explicit locks are authoritative")
  .refine(validInterval, "locked block must end after it starts");
const instantSchema = isoDateTimeSchema.refine(value => Number.isFinite(Date.parse(value)), "invalid instant");

function assertComplete(rows: readonly unknown[], kind: string): void {
  if (rows.length > MAX_CONSTRAINTS) {
    throw new RangeError(`sprint budget ${kind} constraints exceed ${MAX_CONSTRAINTS}`);
  }
}

function storedInstant(value: unknown): string {
  return instantSchema.parse(value instanceof Date ? value.toISOString() : value);
}

/**
 * Two SELECTs only; the caller owns any read-only snapshot transaction.
 * taskIds must be the current course's pending task ids, not all workspace tasks.
 * Day keys are deliberately irrelevant: preserve absolute intervals for the
 * forecast to clip, including elapsed budget and yesterday's cross-midnight work.
 */
export async function readOpeningSprintBudgetConstraints(
  sql: Sql,
  scope: Scope,
  input: { windowStart: string; windowEnd: string; now: string; taskIds: readonly string[] },
): Promise<{ accepted: PlannedBlock[]; locked: TimeBlock[] }> {
  const owned = scopeSchema.parse(scope);
  const window = windowSchema.parse({ start: input.windowStart, end: input.windowEnd });
  const now = instantSchema.parse(input.now);
  const taskIds = [...new Set(uuidSchema.array().max(MAX_CONSTRAINTS).parse(input.taskIds).map(id => id.toLowerCase()))];

  // 0024 gives plan_state only a workspace FK, not an owner column. Join the
  // current workspace owner; do not infer ownership from a JSON task id.
  // JSON has no shape/range CHECK. Non-arrays fail jsonb_array_elements; missing
  // timestamps and invalid intervals are selected to fail schema validation,
  // even when they would otherwise fall outside the requested window. Invalid
  // timestamp casts also fail the read rather than silently dropping a block.
  const acceptedRows = await sql`
    SELECT b.block
    FROM opening_plan_state p
    JOIN workspaces w ON w.id=p.workspace_id AND w.owner_user_id=${owned.ownerUserId}
    CROSS JOIN LATERAL jsonb_array_elements(p.accepted_blocks) WITH ORDINALITY AS b(block, ordinal)
    WHERE p.workspace_id=${owned.workspaceId}
      AND CASE
        WHEN jsonb_typeof(b.block->'start') IS DISTINCT FROM 'string'
          OR jsonb_typeof(b.block->'end') IS DISTINCT FROM 'string' THEN TRUE
        ELSE NOT isfinite((b.block->>'start')::timestamptz)
          OR NOT isfinite((b.block->>'end')::timestamptz)
          OR (b.block->>'start')::timestamptz >= (b.block->>'end')::timestamptz
          OR ((b.block->>'start')::timestamptz < ${window.end}::timestamptz
            AND (b.block->>'end')::timestamptz > ${window.start}::timestamptz)
          OR (lower(b.block->>'taskId')=ANY(${taskIds}::text[])
            AND (b.block->>'end')::timestamptz > ${now}::timestamptz)
      END
    ORDER BY p.day, b.ordinal
    LIMIT ${MAX_CONSTRAINTS + 1}`;
  assertComplete(acceptedRows, "accepted");
  const accepted = acceptedRows.map(row => {
    const block = acceptedSchema.parse(row.block);
    return { ...block, taskId: block.taskId.toLowerCase() };
  });

  // Current settings derive class/sleep/meal afresh. Historical derived rows are
  // not extra constraints. 0024 enforces start_at < end_at for hard blocks, but
  // PostgreSQL also permits infinite timestamps, which our schemas must reject.
  const lockedRows = await sql`
    SELECT h.start_at, h.end_at, h.kind
    FROM opening_hard_blocks h
    JOIN workspaces w ON w.id=h.workspace_id AND w.owner_user_id=${owned.ownerUserId}
    WHERE h.workspace_id=${owned.workspaceId} AND h.owner_user_id=${owned.ownerUserId}
      AND h.kind='locked'
      AND ((h.start_at < ${window.end}::timestamptz AND h.end_at > ${window.start}::timestamptz)
        OR NOT isfinite(h.start_at) OR NOT isfinite(h.end_at))
    ORDER BY h.start_at, h.end_at, h.id
    LIMIT ${MAX_CONSTRAINTS + 1}`;
  assertComplete(lockedRows, "locked");
  const locked = lockedRows.map(row => lockedSchema.parse({
    start: storedInstant(row.start_at),
    end: storedInstant(row.end_at),
    kind: row.kind,
  }));
  return { accepted, locked };
}
