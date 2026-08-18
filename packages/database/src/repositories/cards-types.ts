import {
  reviewCardSchema,
  reviewStateSchema,
  type LearningEvent,
  type ReviewGrade,
  type ReviewQueueMode,
  type ReviewState,
} from "@aistudy/contracts";

export type CardErrorCode = "NOT_FOUND" | "VALIDATION" | "WORKSPACE_MISMATCH" | "CONFLICT";

export class CardRepositoryError extends Error {
  constructor(
    readonly code: CardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CardRepositoryError";
  }
}

export type CardRecord = {
  id: string;
  ownerUserId: string;
  front: string;
  back: string;
  sourceDocumentId: string | null;
  syllabusPointId: string | null;
  tags: string[];
  archived: boolean;
  contentVersion: number;
  pausedUntil: string | null;
  maintainUntil: string | null;
  excludeFromAssessment: boolean;
  createdAt: string;
};

export type CardStateRecord = ReviewState & { workspaceId: string; ownerUserId: string };

export type CardQueueEntry = {
  card: CardRecord;
  state: CardStateRecord;
  goalPriority: number;
};

export type CardRepository = {
  createCard(input: {
    workspaceId: string;
    ownerUserId: string;
    front: string;
    back: string;
    tags?: string[];
    sourceDocumentId?: string | null;
    syllabusPointId?: string | null;
    cardId?: string;
  }): Promise<CardRecord>;
  getCard(input: { workspaceId: string; cardId: string }): Promise<CardRecord>;
  updateControls(input: {
    workspaceId: string;
    cardId: string;
    archived?: boolean;
    pausedUntil?: string | null;
    maintainUntil?: string | null;
    excludeFromAssessment?: boolean;
  }): Promise<CardRecord>;
  getState(input: {
    workspaceId: string;
    ownerUserId: string;
    cardId: string;
  }): Promise<CardStateRecord | null>;
  upsertState(input: {
    workspaceId: string;
    ownerUserId: string;
    state: ReviewState;
  }): Promise<CardStateRecord>;
  grade(input: {
    workspaceId: string;
    ownerUserId: string;
    cardId: string;
    grade: ReviewGrade;
    idempotencyKey: string;
    occurredAt: string;
    assisted?: boolean;
    now?: Date;
  }): Promise<{ state: CardStateRecord; event: LearningEvent; created: boolean }>;
  listQueue(input: {
    workspaceId: string;
    ownerUserId: string;
    mode: ReviewQueueMode;
    now?: Date;
    today?: string;
  }): Promise<CardQueueEntry[]>;
  listCards(input: {
    workspaceId: string;
    ownerUserId: string;
  }): Promise<CardRecord[]>;
};

export type Row = Record<string, unknown>;

export function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

export function toDateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return (value as Date).toISOString().slice(0, 10);
}

export function mapCard(row: Row): CardRecord {
  return reviewCardSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    front: row.front,
    back: row.back,
    sourceDocumentId: row.source_document_id,
    syllabusPointId: row.syllabus_point_id,
    tags: row.tags ?? [],
    archived: row.archived,
    contentVersion: row.content_version,
    pausedUntil: row.paused_until == null ? null : toIso(row.paused_until),
    maintainUntil: toDateOnly(row.maintain_until),
    excludeFromAssessment: row.exclude_from_assessment,
    createdAt: toIso(row.created_at),
  });
}

export function mapState(row: Row): CardStateRecord {
  const state = reviewStateSchema.parse({
    cardId: row.card_id,
    ease: Number(row.ease),
    intervalDays: Number(row.interval_days),
    dueAt: toIso(row.due_at),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    lastGrade: row.last_grade,
    updatedAt: toIso(row.updated_at),
  });
  return {
    ...state,
    workspaceId: row.workspace_id as string,
    ownerUserId: row.owner_user_id as string,
  };
}
