import { expect, it } from "vitest";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import { toSnapshotEvidence } from "./snapshot-evidence";

const now = new Date(learningObservation.occurredAt);

it("preserves requirement and captured item identity through the full-evidence projection", () => {
  const evidence = courseEvidence();
  const mapped = toSnapshotEvidence(evidence, now);
  expect(mapped.summaries[0]?.requirementKey).toBe(qualifiedInput.observation.requirementKey);
  expect(mapped.observations[0]).toMatchObject({
    requirementKey: qualifiedInput.observation.requirementKey,
    itemVersionId: qualifiedInput.observation.itemVersionId,
    usableForCurrentVersion: "yes",
  });
});

it.each([
  ["source changed", "unknown"], ["source unavailable", "no"],
])("keeps the recorded correctness separate from %s applicability", (name, usableForCurrentVersion) => {
  const evidence = courseEvidenceCases.find(item => item.name === name)!.evidence;
  expect(toSnapshotEvidence(evidence, now).observations[0])
    .toMatchObject({ verifiedCorrect: "yes", usableForCurrentVersion });
});

it("normalizes aliases within a requirement without merging different requirements or legacy evidence", () => {
  const rows = [
    { ...learningObservation, id: "calculate", skillLabel: "  ＦＲＡＣＴＩＯＮＳ  " },
    { ...learningObservation, id: "prove", skillLabel: "fractions" },
    { ...learningObservation, id: "alias", skillLabel: "Fractions" },
    { ...learningObservation, id: "legacy", skillLabel: "fractions" },
  ];
  const mapped = toSnapshotEvidence({ observations: rows, evidenceContexts: Object.fromEntries(rows.slice(0, 3).map(row => [row.id, {
    ...qualifiedInput, observation: { ...qualifiedInput.observation,
      submittedAt: (qualifiedInput.observation.submittedAt ?? 0) + (row.id === "alias" ? 1 : 0),
      requirementKey: row.id === "prove" ? "proof" : "calculation" },
  }])) }, now);
  expect(mapped.summaries).toHaveLength(3);
  expect(mapped.summaries.map(row => row.requirementKey)).toEqual(expect.arrayContaining(["calculation", "proof", null]));
  expect(mapped.observations.find(row => row.id === "alias")?.skillLabel).toBe(rows[0]!.skillLabel);
  expect(mapped.observations.find(row => row.id === "prove")?.skillLabel).toBe("fractions");
  expect(mapped.observations.find(row => row.id === "legacy"))
    .toMatchObject({ requirementKey: null, usableForCurrentVersion: "unknown", verifiedCorrect: "unknown" });
});
