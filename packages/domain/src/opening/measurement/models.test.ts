import { describe, expect, it } from "vitest";
import {
  bktCorrectProbability, CLASSICAL_BKT_PARAMETERS, predictClassicalBkt,
  predictSmoothedFrequency, updateBktKnowledge, type ClassicalBktParameters,
} from "./models";

/** Independent oracle: sum joint probabilities of all hidden-state paths,
 * then condition once at the end. Does not use the implementation's posterior
 * recurrence. Classic BKT has no known -> unknown transition. */
function enumeratePrediction(history: readonly boolean[], p: ClassicalBktParameters): number {
  let paths = [{ known: true, weight: p.initialKnowledge }, { known: false, weight: 1 - p.initialKnowledge }];
  for (const correct of history) {
    paths = paths.flatMap(path => {
      const chance = path.known ? 1 - p.slip : p.guess;
      const weight = path.weight * (correct ? chance : 1 - chance);
      return path.known ? [{ known: true, weight }] : [
        { known: true, weight: weight * p.learning },
        { known: false, weight: weight * (1 - p.learning) },
      ];
    });
  }
  const evidence = paths.reduce((sum, path) => sum + path.weight, 0);
  return paths.reduce((sum, path) => sum + path.weight * (path.known ? 1 - p.slip : p.guess), 0) / evidence;
}

describe("classical BKT numerical validity", () => {
  it("matches a hidden-state path oracle on every answer sequence of length zero through eight", () => {
    for (let length = 0; length <= 8; length += 1) {
      for (let bits = 0; bits < 2 ** length; bits += 1) {
        const history = Array.from({ length }, (_, index) => Boolean(bits & (1 << index)));
        expect(predictClassicalBkt(history), JSON.stringify(history))
          .toBeCloseTo(enumeratePrediction(history, CLASSICAL_BKT_PARAMETERS), 12);
      }
    }
  });

  it.each([
    { initialKnowledge: 0, learning: 0, guess: 0.25, slip: 0.1 },
    { initialKnowledge: 1, learning: 0, guess: 0.25, slip: 0.1 },
    { initialKnowledge: 0.4, learning: 1, guess: 0.2, slip: 0.15 },
    { initialKnowledge: 0.4, learning: 0, guess: 0.2, slip: 0.15 },
  ])("preserves valid boundary parameters $initialKnowledge / $learning", parameters => {
    const history = [true, false, false, true];
    const knowledge = history.reduce((state, answer) => updateBktKnowledge(state, answer, parameters), parameters.initialKnowledge);
    expect(bktCorrectProbability(knowledge, parameters)).toBeCloseTo(enumeratePrediction(history, parameters), 12);
  });

  it("keeps long correct, incorrect and alternating histories finite without treating prediction as mastery", () => {
    const histories = [Array<boolean>(10_000).fill(true), Array<boolean>(10_000).fill(false),
      Array.from({ length: 10_000 }, (_, index) => index % 2 === 0)];
    for (const history of histories) {
      const prediction = predictClassicalBkt(history);
      expect(prediction).toBeGreaterThanOrEqual(CLASSICAL_BKT_PARAMETERS.guess);
      expect(prediction).toBeLessThanOrEqual(1 - CLASSICAL_BKT_PARAMETERS.slip);
    }
    expect(predictClassicalBkt(histories[0]!)).toBeCloseTo(0.9, 12);
    expect(predictClassicalBkt(histories[1]!)).toBeLessThan(predictClassicalBkt([]));
    expect(predictClassicalBkt([true, false])).not.toBeCloseTo(predictClassicalBkt([false, true]), 6);
    expect(predictSmoothedFrequency([true, false])).toBe(predictSmoothedFrequency([false, true]));
  });

  it("rejects conditioning on impossible observations instead of returning NaN", () => {
    expect(() => updateBktKnowledge(0, true, { ...CLASSICAL_BKT_PARAMETERS, guess: 0 })).toThrow(RangeError);
    expect(() => updateBktKnowledge(1, false, { ...CLASSICAL_BKT_PARAMETERS, slip: 0 })).toThrow(RangeError);
  });
});
