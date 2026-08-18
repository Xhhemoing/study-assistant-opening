import type { ReviewQueueMode, ReviewState } from "@aistudy/contracts";
import { reviewQueueModeSchema } from "@aistudy/contracts";
import { buildReviewQueue, type ReviewQueueItem } from "@aistudy/domain";
import type { Sql } from "postgres";
import {
  CardRepositoryError,
  mapCard,
  mapState,
  type CardQueueEntry,
  type CardRecord,
  type CardStateRecord,
  type Row,
} from "./cards-types";

export async function assertWorkspaceOwner(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
): Promise<void> {
  const rows = await client<{ owner_user_id: string }[]>`
    SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
  if (rows[0]!.owner_user_id !== ownerUserId) {
    throw new CardRepositoryError(
      "WORKSPACE_MISMATCH",
      "Card owner must match workspace owner",
    );
  }
}

export async function lockCardForUpdate(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  cardId: string,
): Promise<void> {
  const rows = await client`
    SELECT id FROM cards
    WHERE workspace_id = ${workspaceId}
      AND owner_user_id = ${ownerUserId}
      AND id = ${cardId}
    FOR UPDATE
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Card not found: ${cardId}`);
  }
}

export async function loadReviewStateForUpdate(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  cardId: string,
): Promise<CardStateRecord | null> {
  const rows = await client`
    SELECT * FROM card_review_states
    WHERE workspace_id = ${workspaceId}
      AND owner_user_id = ${ownerUserId}
      AND card_id = ${cardId}
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ? mapState(rows[0] as Row) : null;
}

export async function loadCard(
  client: Sql,
  workspaceId: string,
  cardId: string,
): Promise<CardRecord> {
  const rows = await client`
    SELECT * FROM cards WHERE id = ${cardId} AND workspace_id = ${workspaceId} LIMIT 1
  `;
  if (!rows.length) {
    throw new CardRepositoryError("NOT_FOUND", `Card not found: ${cardId}`);
  }
  return mapCard(rows[0] as Row);
}

export async function writeState(
  client: Sql,
  workspaceId: string,
  ownerUserId: string,
  state: ReviewState,
): Promise<CardStateRecord> {
  const rows = await client`
    INSERT INTO card_review_states (
      owner_user_id, card_id, workspace_id, ease, interval_days, due_at,
      reps, lapses, last_grade, updated_at
    ) VALUES (
      ${ownerUserId}, ${state.cardId}, ${workspaceId}, ${state.ease},
      ${state.intervalDays}, ${state.dueAt}, ${state.reps}, ${state.lapses},
      ${state.lastGrade}, ${state.updatedAt}
    )
    ON CONFLICT (owner_user_id, card_id) DO UPDATE SET
      ease = EXCLUDED.ease,
      interval_days = EXCLUDED.interval_days,
      due_at = EXCLUDED.due_at,
      reps = EXCLUDED.reps,
      lapses = EXCLUDED.lapses,
      last_grade = EXCLUDED.last_grade,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  return mapState(rows[0] as Row);
}

export async function listWorkspaceCards(
  sql: Sql,
  input: { workspaceId: string; ownerUserId: string },
): Promise<CardRecord[]> {
  await assertWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
  const rows = await sql`
    SELECT * FROM cards
    WHERE workspace_id = ${input.workspaceId}
      AND owner_user_id = ${input.ownerUserId}
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => mapCard(row as Row));
}

export async function listCardQueue(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    mode: ReviewQueueMode;
    now?: Date;
    today?: string;
  },
): Promise<CardQueueEntry[]> {
  const mode = reviewQueueModeSchema.parse(input.mode);
  const now = input.now ?? new Date();
  const today = input.today ?? now.toISOString().slice(0, 10);
  const rows = await sql`
    SELECT c.*, s.ease, s.interval_days, s.due_at, s.reps, s.lapses, s.last_grade,
      s.updated_at AS state_updated_at, s.owner_user_id AS state_owner_user_id,
      COALESCE(MAX(g.priority), 0)::int AS goal_priority
    FROM cards c
    INNER JOIN card_review_states s
      ON s.card_id = c.id
     AND s.workspace_id = c.workspace_id
     AND s.owner_user_id = ${input.ownerUserId}
    LEFT JOIN course_asset_memberships m
      ON m.asset_type = 'card' AND m.asset_id = c.id AND m.workspace_id = c.workspace_id
    LEFT JOIN course_goals g
      ON g.course_id = m.course_id AND g.workspace_id = c.workspace_id
     AND g.active = true AND g.archived_at IS NULL
    WHERE c.workspace_id = ${input.workspaceId}
    GROUP BY c.id, s.owner_user_id, s.card_id, s.workspace_id, s.ease, s.interval_days,
      s.due_at, s.reps, s.lapses, s.last_grade, s.updated_at
  `;

  const items: ReviewQueueItem[] = rows.map((row) => {
    const raw = row as Row;
    const card = mapCard(raw);
    const state = mapState({
      ...raw,
      card_id: card.id,
      owner_user_id: raw.state_owner_user_id,
      workspace_id: input.workspaceId,
      updated_at: raw.state_updated_at,
    });
    return { card, state, goalPriority: Number(raw.goal_priority ?? 0) };
  });

  return buildReviewQueue(items, mode, now, today).map(
    (item): CardQueueEntry => ({
      card: item.card as CardRecord,
      state: {
        ...item.state,
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
      },
      goalPriority: item.goalPriority,
    }),
  );
}
