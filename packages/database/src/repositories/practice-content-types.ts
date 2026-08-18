import {
  gradablePracticeItemSchema,
  practiceCandidateRecordSchema,
  practiceSessionRecordSchema,
  publicPracticeItemSchema,
  syllabusPointRecordSchema,
  type GradablePracticeItem,
  type PracticeCandidateRecord,
  type PracticeSessionRecord,
  type PublicPracticeItem,
  type SyllabusPointRecord,
} from "@aistudy/contracts";

export type PracticeContentErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "CONFLICT"
  | "ARCHIVED";

export class PracticeContentRepositoryError extends Error {
  constructor(
    readonly code: PracticeContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PracticeContentRepositoryError";
  }
}

export type PracticeContentRepository = {
  getPublicItem(input: { workspaceId: string; itemId: string }): Promise<PublicPracticeItem>;
  getGradableVersion(input: {
    workspaceId: string;
    itemId: string;
    version: number;
  }): Promise<GradablePracticeItem>;
  listSyllabusPoints(input: {
    workspaceId: string;
    packageId: string;
  }): Promise<SyllabusPointRecord[]>;
  listPracticeCandidates(input: {
    workspaceId: string;
    packageId: string;
  }): Promise<PracticeCandidateRecord[]>;
};

export type PracticeSessionRepository = {
  start(input: {
    workspaceId: string;
    ownerUserId: string;
    practiceItemId: string;
  }): Promise<PracticeSessionRecord>;
  lock(input: {
    workspaceId: string;
    ownerUserId: string;
    sessionId: string;
  }): Promise<PracticeSessionRecord>;
  recordHint(input: {
    workspaceId: string;
    ownerUserId: string;
    sessionId: string;
  }): Promise<{ session: PracticeSessionRecord; hint: string }>;
  recordAnswerReveal(input: {
    workspaceId: string;
    ownerUserId: string;
    sessionId: string;
  }): Promise<PracticeSessionRecord>;
  markSubmitted(input: {
    workspaceId: string;
    ownerUserId: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<PracticeSessionRecord>;
};

export type Row = Record<string, unknown>;

export function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function hintCount(hints: unknown): number {
  return Array.isArray(hints) ? hints.length : 0;
}

function optionsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 ? (value as string[]) : undefined;
}

export function mapPublicItem(row: Row): PublicPracticeItem {
  return publicPracticeItemSchema.parse({
    id: row.practice_item_id ?? row.id,
    contentVersion: Number(row.version ?? row.content_version),
    syllabusPointId: row.syllabus_point_id,
    kind: row.kind,
    stem: row.stem,
    options: optionsOf(row.options),
    abilitySlice: row.ability_slice,
    estimatedMinutes: Number(row.estimated_minutes),
    availableHintCount: hintCount(row.hints),
  });
}

export function mapGradableItem(row: Row): GradablePracticeItem {
  const publicItem = mapPublicItem(row);
  return gradablePracticeItemSchema.parse({
    ...publicItem,
    answerRule: row.answer_rule,
    answerDisplay: row.answer_display,
    hints: row.hints ?? [],
  });
}

export function mapSyllabusPoint(row: Row): SyllabusPointRecord {
  return syllabusPointRecordSchema.parse({
    id: row.id,
    packageId: row.package_id,
    parentId: row.parent_id,
    code: row.code,
    title: row.title,
    sortOrder: Number(row.sort_order),
  });
}

export function mapCandidate(row: Row): PracticeCandidateRecord {
  return practiceCandidateRecordSchema.parse({
    id: row.practice_item_id ?? row.id,
    contentVersion: Number(row.current_version ?? row.version),
    syllabusPointId: row.syllabus_point_id,
    kind: row.kind,
    abilitySlice: row.ability_slice,
    estimatedMinutes: Number(row.estimated_minutes),
  });
}

export function mapSession(row: Row): PracticeSessionRecord {
  return practiceSessionRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    practiceItemId: row.practice_item_id,
    contentVersion: Number(row.content_version),
    startedAt: toIso(row.started_at),
    hintCount: Number(row.hint_count),
    answerRevealedAt: row.answer_revealed_at == null ? null : toIso(row.answer_revealed_at),
    submittedAt: row.submitted_at == null ? null : toIso(row.submitted_at),
  });
}
