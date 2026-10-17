import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("V2-14 teaching resume database surfaces", () => {
  it("setStatus exists on activities repo", () => {
    const src = readFileSync(
      resolve(__dirname, "opening-teaching-activities.ts"),
      "utf8",
    );
    expect(src).toMatch(/async setStatus\(/);
    expect(src).toMatch(/status: "active" \| "paused"/);
  });

  it("saveCheckpoint merges via mergeCheckpointResumePatch + CAS", () => {
    const src = readFileSync(
      resolve(__dirname, "opening-teaching-content.ts"),
      "utf8",
    );
    expect(src).toMatch(/async saveCheckpoint\(/);
    expect(src).toMatch(/mergeCheckpointResumePatch/);
    expect(src).toMatch(/stale activity content version for checkpoint save/);
    expect(src).toMatch(/draft_anchor_lost/);
  });

  it("activity-scoped help + attempt + observation head lists exist", () => {
    const help = readFileSync(
      resolve(__dirname, "opening-learning-help.ts"),
      "utf8",
    );
    const attempts = readFileSync(
      resolve(__dirname, "opening-learning-attempts.ts"),
      "utf8",
    );
    const obs = readFileSync(
      resolve(__dirname, "opening-learning-observations.ts"),
      "utf8",
    );
    const facts = readFileSync(
      resolve(__dirname, "opening-learning-facts.ts"),
      "utf8",
    );
    expect(help).toMatch(/listDeliveredHelpByActivity/);
    expect(attempts).toMatch(/listByActivity/);
    expect(obs).toMatch(/listObservationHeadsByActivity/);
    expect(facts).toMatch(/probeLearningSourcesAvailability/);
  });

});
