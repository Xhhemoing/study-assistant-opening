import { expect, it } from "vitest";
import { validateOpeningBackupCards } from "./backup-cards";
const id = "11111111-1111-4111-8111-111111111111", owner = "22222222-2222-4222-8222-222222222222", course = "33333333-3333-4333-8333-333333333333";
const card = { id, owner_user_id: owner, front: "Question", back: "Reference", course_id: course, skill_label: "fractions", source_document_id: null, source_ids: [] };
it("retains course-attributed independent cards while accepting legacy backups without cards", () => {
  const errors: string[] = [];
  validateOpeningBackupCards({}, errors);
  validateOpeningBackupCards({ courses: [{ id: course }], cards: [card] }, errors);
  expect(errors).toEqual([]);
});
it("rejects missing courses, source-note references, and orphaned states/events", () => {
  const errors: string[] = [];
  validateOpeningBackupCards({ cards: [card, { ...card, source_document_id: id }], card_review_states: [{ card_id: owner }], learning_events: [{ content_id: owner, type: "review" }] }, errors);
  expect(errors).toContain("card course is not included");
  expect(errors).toContain("Opening card is invalid or requires native note backup");
  expect(errors).toContain("card review state is invalid or orphaned");
  expect(errors).toContain("card review event is invalid or orphaned");
});

it("rejects automatic cards with missing or foreign observation roots", () => {
  const root = "44444444-4444-4444-8444-444444444444";
  const base = { courses: [{ id: course }], cards: [{ ...card, origin_observation_root_id: root }] };
  const missing: string[] = [], foreign: string[] = [], valid: string[] = [];
  validateOpeningBackupCards(base, missing);
  validateOpeningBackupCards({ ...base, opening_learning_observations: [{ id: root, owner_user_id: id }] }, foreign);
  validateOpeningBackupCards({ ...base, opening_learning_observations: [{ id: root, owner_user_id: owner, root_observation_id: root }] }, valid);
  expect(missing.length).toBeGreaterThan(0);
  expect(foreign.length).toBeGreaterThan(0);
  expect(valid).toEqual([]);
});
it("rejects an FSRS algorithm label without its required memory state", () => {
  const errors: string[] = [];
  validateOpeningBackupCards({ courses: [{ id: course }], cards: [card], card_review_states: [{ card_id: id, owner_user_id: owner,
    ease: 2.5, interval_days: 1, due_at: "2026-10-01T00:00:00Z", reps: 1, lapses: 0, last_grade: "good", updated_at: "2026-09-30T00:00:00Z", srs_version: "fsrs-5.4.2" }] }, errors);
  expect(errors).toContain("card review state is invalid or orphaned");
});
