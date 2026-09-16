import { describe, expect, it } from "vitest";
import {
  qualifyObservationAssistance,
  resolveAssistance,
} from "./assistance";

describe("resolveAssistance", () => {
  it("does not let the browser erase known answer exposure", () => {
    expect(resolveAssistance("independent", ["hinted"])).toBe("hinted");
    expect(resolveAssistance("independent", ["hinted", "revealed"])).toBe(
      "revealed",
    );
    expect(resolveAssistance("unknown", [])).toBe("unknown");
  });

  it("returns declared when exposures are empty", () => {
    expect(resolveAssistance("independent", [])).toBe("independent");
    expect(resolveAssistance("hinted", [])).toBe("hinted");
    expect(resolveAssistance("revealed", [])).toBe("revealed");
  });

  it("prefers revealed over hinted", () => {
    expect(resolveAssistance("hinted", ["revealed"])).toBe("revealed");
    expect(resolveAssistance("unknown", ["hinted"])).toBe("hinted");
  });
});

describe("qualifyObservationAssistance", () => {
  const problemId = "11111111-1111-4111-8111-111111111111";

  it("no problemId + independent+correct → allowsIndependent false", () => {
    const q = qualifyObservationAssistance({
      declared: "independent",
      exposures: [],
      problemId: null,
      outcome: "correct",
    });
    expect(q.assistance).toBe("independent");
    expect(q.allowsIndependent).toBe(false);
  });

  it("problemId + independent+correct → allowsIndependent true", () => {
    const q = qualifyObservationAssistance({
      declared: "independent",
      exposures: [],
      problemId,
      outcome: "correct",
    });
    expect(q.assistance).toBe("independent");
    expect(q.allowsIndependent).toBe(true);
  });

  it("revealed exposure forces assistance revealed and allowsIndependent false", () => {
    const q = qualifyObservationAssistance({
      declared: "independent",
      exposures: ["revealed"],
      problemId,
      outcome: "correct",
    });
    expect(q.assistance).toBe("revealed");
    expect(q.allowsIndependent).toBe(false);
  });
});
