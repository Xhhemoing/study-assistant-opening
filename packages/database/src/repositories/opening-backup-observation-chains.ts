type Row = Record<string, unknown>;
type LearningTables = Record<"opening_learning_observations" | "opening_learning_attempts" | "opening_turns" | "opening_help_exposures", Row[]>;
/** Privacy filtering must remove a whole chain, never restore an older row as its effective head. */
export function retainCompleteObservationChains(tables: LearningTables, lineage: Row[]): void {
  let previousSize = -1;
  const size = () => tables.opening_learning_observations.length + tables.opening_learning_attempts.length + tables.opening_turns.length + tables.opening_help_exposures.length;
  while (previousSize !== size()) {
    previousSize = size();
    const observationIds = new Set(tables.opening_learning_observations.map(row => row.id));
    const excludedRoots = new Set(lineage.filter(row => !observationIds.has(row.id)
      || !observationIds.has(row.root_observation_id ?? row.id)
      || (row.revises_observation_id != null && !observationIds.has(row.revises_observation_id))
      || (row.effective_head_id != null && !observationIds.has(row.effective_head_id)))
      .map(row => row.root_observation_id ?? row.id));
    tables.opening_learning_observations = tables.opening_learning_observations.filter(row => !excludedRoots.has(row.root_observation_id ?? row.id));
    const completeIds = new Set(tables.opening_learning_observations.map(row => row.id));
    tables.opening_learning_attempts = tables.opening_learning_attempts.filter(row => row.observation_id == null || completeIds.has(row.observation_id));
    const attemptIds = new Set(tables.opening_learning_attempts.map(row => row.id));
    tables.opening_turns = tables.opening_turns.filter(row => row.attempt_id == null || attemptIds.has(row.attempt_id));
    const turnIds = new Set(tables.opening_turns.map(row => row.id));
    tables.opening_help_exposures = tables.opening_help_exposures.filter(row => turnIds.has(row.turn_id) && (row.attempt_id == null || attemptIds.has(row.attempt_id)));
    tables.opening_learning_observations = tables.opening_learning_observations.filter(row => (row.attempt_id == null || attemptIds.has(row.attempt_id))
      && (row.source_turn_ids as string[]).every(turn => turnIds.has(turn)));
  }
}
