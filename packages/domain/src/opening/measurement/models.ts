/** Classical binary BKT; the uploaded multidimensional evidence engine is a different model. */
export type ClassicalBktParameters = Readonly<{
  initialKnowledge: number;
  learning: number;
  guess: number;
  slip: number;
}>;

/** Starting assumptions for shadow evaluation, not fitted estimates of this learner. */
export const CLASSICAL_BKT_PARAMETERS: ClassicalBktParameters = {
  initialKnowledge: 0.2,
  learning: 0.1,
  // Four options in the initial bank; uniform guessing is an assumption, not a fit.
  guess: 0.25,
  slip: 0.1,
};

export const FREQUENCY_PARAMETERS = { priorCorrect: 1, priorIncorrect: 1 } as const;

/** Probability of an independent correct answer, not probability of mastery. */
export function bktCorrectProbability(knowledge: number, parameters: ClassicalBktParameters): number {
  return knowledge * (1 - parameters.slip) + (1 - knowledge) * parameters.guess;
}

/** Condition on this answer, then apply the learning transition for the next attempt. */
export function updateBktKnowledge(knowledge: number, correct: boolean, parameters: ClassicalBktParameters): number {
  const knownLikelihood = correct ? 1 - parameters.slip : parameters.slip;
  const unknownLikelihood = correct ? parameters.guess : 1 - parameters.guess;
  const denominator = knowledge * knownLikelihood + (1 - knowledge) * unknownLikelihood;
  if (denominator === 0) throw new RangeError("Cannot condition BKT on a zero-likelihood answer");
  const posterior = knowledge * knownLikelihood / denominator;
  return posterior + (1 - posterior) * parameters.learning;
}

export function predictClassicalBkt(history: readonly boolean[]): number {
  const knowledge = history.reduce((state, correct) => updateBktKnowledge(state, correct, CLASSICAL_BKT_PARAMETERS),
    CLASSICAL_BKT_PARAMETERS.initialKnowledge);
  return bktCorrectProbability(knowledge, CLASSICAL_BKT_PARAMETERS);
}

export function predictSmoothedFrequency(history: readonly boolean[]): number {
  const correct = history.filter(Boolean).length;
  return (correct + FREQUENCY_PARAMETERS.priorCorrect) /
    (history.length + FREQUENCY_PARAMETERS.priorCorrect + FREQUENCY_PARAMETERS.priorIncorrect);
}
