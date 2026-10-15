import { createCardRequestSchema, gradeReviewRequestSchema, reviewStateSchema } from "@aistudy/contracts";
import { isUuid, parseUuidArray } from "./backup-validation";

type Row = Record<string, unknown>;
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;

/** Independent cards only: source-note cards require native backup's document provenance. */
export function validateOpeningBackupCards(tables: Record<string, Row[]>, errors: string[]): void {
  const cards = new Map<string, Row>();
  const sources = new Set((tables.opening_sources ?? []).map(row => String(row.id).toLowerCase()));
  const courseIds = new Set((tables.courses ?? []).map(row => String(row.id).toLowerCase()));
  for (const row of tables.cards ?? []) {
    const parsed = createCardRequestSchema.safeParse({ cardId: row.id, front: row.front, back: row.back,
      sourceDocumentId: row.source_document_id, courseId: row.course_id, skillLabel: row.skill_label, tags: row.tags });
    if (!parsed.success || !isUuid(row.id) || !isUuid(row.owner_user_id) || row.source_document_id != null) {
      errors.push("Opening card is invalid or requires native note backup"); continue;
    }
    const sourceIds = parseUuidArray(row.source_ids);
    if (!sourceIds || sourceIds.length > 32 || sourceIds.some(id => !sources.has(id.toLowerCase()))) errors.push("card source lineage is missing or outside the backup");
    if (row.course_id != null && (!isUuid(row.course_id) || !courseIds.has(row.course_id.toLowerCase()))) errors.push("card course is not included");
    if (cards.has(row.id.toLowerCase())) errors.push("card is duplicated");
    cards.set(row.id.toLowerCase(), row);
  }
  const states = new Set<string>();
  for (const row of tables.card_review_states ?? []) {
    const card = typeof row.card_id === "string" ? cards.get(row.card_id.toLowerCase()) : undefined;
    const parsed = reviewStateSchema.safeParse({ cardId: row.card_id, ease: row.ease, intervalDays: row.interval_days,
      dueAt: iso(row.due_at), reps: row.reps, lapses: row.lapses, lastGrade: row.last_grade, updatedAt: iso(row.updated_at) });
    if (!card || card.owner_user_id !== row.owner_user_id || !parsed.success) errors.push("card review state is invalid or orphaned");
    const identity = `${row.owner_user_id}:${row.card_id}`;
    if (states.has(identity)) errors.push("card review state is duplicated");
    states.add(identity);
  }
  const keys = new Set<string>();
  for (const row of tables.learning_events ?? []) {
    const card = typeof row.content_id === "string" ? cards.get(row.content_id.toLowerCase()) : undefined;
    const payload = row.payload as { grade?: unknown } | null;
    const parsed = gradeReviewRequestSchema.safeParse({ cardId: row.content_id, grade: payload?.grade,
      idempotencyKey: row.idempotency_key, occurredAt: iso(row.occurred_at) });
    if (!card || card.owner_user_id !== row.owner_user_id || row.type !== "review" || row.corrects_event_id != null || !parsed.success) errors.push("card review event is invalid or orphaned");
    const identity = `${row.owner_user_id}:${row.idempotency_key}`;
    if (keys.has(identity)) errors.push("card review event is duplicated");
    keys.add(identity);
  }
}
