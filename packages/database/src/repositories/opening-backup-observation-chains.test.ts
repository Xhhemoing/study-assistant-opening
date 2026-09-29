import { expect, it } from "vitest";
import { retainCompleteObservationChains } from "./opening-backup-observation-chains";
it("removes a root when its head was privacy filtered, together with dependent attempt/help", () => {
  const root = { id: "root", effective_head_id: "head", attempt_id: "attempt", source_turn_ids: [] };
  const lineage = [root, { id: "head", root_observation_id: "root", revises_observation_id: "root" }];
  const tables = { opening_learning_observations: [root], opening_learning_attempts: [{ id: "attempt", observation_id: "root" }],
    opening_turns: [{ id: "turn", attempt_id: "attempt" }], opening_help_exposures: [{ id: "help", attempt_id: "attempt", turn_id: "turn" }] };
  retainCompleteObservationChains(tables,lineage);
  expect(Object.values(tables).every(rows => rows.length === 0)).toBe(true);
});
it("does not discard intact legacy roots or a tombstone chain", () => {
  const rows = [{ id: "legacy", source_turn_ids: [] }, { id: "root", root_observation_id: "root", effective_head_id: "head", source_turn_ids: [] },
    { id: "head", root_observation_id: "root", revises_observation_id: "root", revision_kind: "retract", source_turn_ids: [] }];
  const tables = { opening_learning_observations: [...rows], opening_learning_attempts: [], opening_turns: [], opening_help_exposures: [] };
  retainCompleteObservationChains(tables,rows);
  expect(tables.opening_learning_observations).toEqual(rows);
});

it("removes a chain with a missing middle revision even if its root and head are included", () => {
  const root = { id: "root", root_observation_id: "root", effective_head_id: "head", source_turn_ids: [] };
  const middle = { id: "middle", root_observation_id: "root", revises_observation_id: "root", source_turn_ids: [] };
  const head = { id: "head", root_observation_id: "root", revises_observation_id: "middle", source_turn_ids: [] };
  const legacy = { id: "legacy", root_observation_id: null, effective_head_id: null, revises_observation_id: null, source_turn_ids: [] };
  const tables = { opening_learning_observations: [root, head, legacy], opening_learning_attempts: [], opening_turns: [], opening_help_exposures: [] };
  retainCompleteObservationChains(tables, [root, middle, head, legacy]);
  expect(tables.opening_learning_observations).toEqual([legacy]);
});

it("repeats dependency filtering when a removed attempt turn invalidates another chain", () => {
  const root = { id: "root", effective_head_id: "missing-head", attempt_id: "attempt", source_turn_ids: [] };
  const linkedRoot = { id: "linked-root", effective_head_id: "linked-head", source_turn_ids: [] };
  const linkedHead = { id: "linked-head", root_observation_id: "linked-root", revises_observation_id: "linked-root", source_turn_ids: ["turn"] };
  const legacy = { id: "legacy", source_turn_ids: [] };
  const tables = { opening_learning_observations: [root, linkedRoot, linkedHead, legacy],
    opening_learning_attempts: [{ id: "attempt", observation_id: "root" }],
    opening_turns: [{ id: "turn", attempt_id: "attempt" }],
    opening_help_exposures: [{ id: "help", turn_id: "turn", attempt_id: "attempt" }] };
  retainCompleteObservationChains(tables, [...tables.opening_learning_observations,
    { id: "missing-head", root_observation_id: "root", revises_observation_id: "root" }]);
  expect(tables.opening_learning_observations).toEqual([legacy]);
  expect(tables.opening_learning_attempts).toEqual([]);
  expect(tables.opening_turns).toEqual([]);
  expect(tables.opening_help_exposures).toEqual([]);
});
