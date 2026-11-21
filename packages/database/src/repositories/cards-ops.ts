import { cardReadable } from "./card-sources";
import type { ReviewQueueMode, ReviewState } from "@aistudy/contracts";
import { reviewQueueModeSchema } from "@aistudy/contracts";
import {
  buildReviewQueue,
  localDateKeyInZone,
  resolveWorkspaceTimeZone,
  type ReviewQueueItem,
} from "@aistudy/domain";
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
    SELECT c.* FROM cards c WHERE c.id = ${cardId} AND c.workspace_id = ${workspaceId}
      AND ${cardReadable(client, workspaceId)} LIMIT 1
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
      reps, lapses, last_grade, updated_at, srs_version, fsrs_state
    ) VALUES (
      ${ownerUserId}, ${state.cardId}, ${workspaceId}, ${state.ease},
      ${state.intervalDays}, ${state.dueAt}, ${state.reps}, ${state.lapses},
      ${state.lastGrade}, ${state.updatedAt}, ${state.srsVersion ?? "srs-1"}, ${state.fsrs ? client.json(state.fsrs) : null}
    )
    ON CONFLICT (owner_user_id, card_id) DO UPDATE SET
      srs_version = EXCLUDED.srs_version,
      fsrs_state = EXCLUDED.fsrs_state,
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
    SELECT c.* FROM cards c
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.owner_user_id = ${input.ownerUserId}
      AND ${cardReadable(sql, input.workspaceId)}
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => mapCard(row as Row));
}

function deriveCardKnowledgeUnitKey(card: CardRecord): string | undefined {
  if (!card.syllabusPointId && !card.skillLabel) return undefined;
  const scope = card.courseId ?? "workspace";
  const unit = card.syllabusPointId
    ? `sp:${card.syllabusPointId}`
    : `sk:${card.skillLabel!.trim().toLowerCase()}`;
  const dimension = card.originObservationRootId || card.tags.includes("review:question")
    ? "question"
    : card.tags.includes("review:concept")
      ? "concept"
      : "general";
  return `${scope}:${unit}:${dimension}`;
}

function deriveCardFamilyKey(card: CardRecord): string | undefined {
  if (card.originObservationRootId) return `obs:${card.originObservationRootId}`;
  if (card.skillLabel) return `${card.courseId ?? "workspace"}:skill:${card.skillLabel.trim().toLowerCase()}`;
  if (card.syllabusPointId) return `${card.courseId ?? "workspace"}:sp:${card.syllabusPointId}`;
  return undefined;
}

export async function listCardQueue(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    mode: ReviewQueueMode;
    now?: Date;
    today?: string;
    /**
     * Workspace business IANA zone (planning_settings.timeZone). Missing/blank →
     * DEFAULT_WORKSPACE_TIME_ZONE (Asia/Shanghai). Invalid zone → RangeError
     * (explicit failure, never a silent UTC fallback).
     */
    timeZone?: string | null;
    /** Optional session card cap applied strictly after global 5-band triage. */
    maxSessionCards?: number;
  },
): Promise<CardQueueEntry[]> {
  const mode = reviewQueueModeSchema.parse(input.mode);
  const now = input.now ?? new Date();
  // Local business day of `now` in the workspace zone — NOT the UTC date (TZ01).
  const today = input.today ?? localDateKeyInZone(now, resolveWorkspaceTimeZone(input.timeZone));
  // Pure read across all eligible cards (no pre-triage SQL LIMIT and zero writes to cards/review_states/events).
  const rows = await sql`
    SELECT c.*, s.srs_version, s.fsrs_state, s.ease, s.interval_days, s.due_at, s.reps, s.lapses, s.last_grade,
      s.updated_at AS state_updated_at, s.owner_user_id AS state_owner_user_id,
      COALESCE(MAX(g.priority), 0)::int AS goal_priority,
      EXISTS (
        SELECT 1 FROM opening_retest_activities r
        WHERE r.workspace_id = c.workspace_id
          AND r.owner_user_id = ${input.ownerUserId}
          AND c.course_id IS NOT NULL
          AND c.skill_label IS NOT NULL
          AND r.course_id = c.course_id
          AND r.skill_label = c.skill_label
          AND r.status IN ('proposed', 'accepted', 'in_progress')
      ) AS delayed_check_covered
    FROM cards c
    INNER JOIN card_review_states s
      ON s.card_id = c.id
     AND s.workspace_id = c.workspace_id
     AND s.owner_user_id = ${input.ownerUserId}
    LEFT JOIN course_asset_memberships m
      ON m.asset_type = 'card' AND m.asset_id = c.id AND m.workspace_id = c.workspace_id
    LEFT JOIN course_goals g
      ON (g.course_id IN (m.course_id,c.course_id) OR EXISTS (SELECT 1 FROM course_goal_links gl WHERE gl.workspace_id=g.workspace_id AND gl.goal_id=g.id AND gl.course_id IN (m.course_id,c.course_id))) AND g.workspace_id = c.workspace_id
     AND g.active = true AND g.archived_at IS NULL
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.auto_paused = false
      AND ${cardReadable(sql, input.workspaceId)}
    GROUP BY c.id, s.owner_user_id, s.card_id, s.workspace_id, s.srs_version, s.fsrs_state, s.ease, s.interval_days,
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
    const knowledgeUnitKey = deriveCardKnowledgeUnitKey(card);
    const familyKey = deriveCardFamilyKey(card);
    const delayedCheckCovered = Boolean(raw.delayed_check_covered);
    return {
      card,
      state,
      goalPriority: Number(raw.goal_priority ?? 0),
      ...(knowledgeUnitKey ? { knowledgeUnitKey } : {}),
      ...(familyKey ? { familyKey } : {}),
      ...(delayedCheckCovered ? { delayedCheckCovered: true } : {}),
    };
  });

  const queueOptions = input.maxSessionCards !== undefined
    ? { maxSessionCards: input.maxSessionCards }
    : undefined;

  return buildReviewQueue(items, mode, now, today, queueOptions).map(
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
