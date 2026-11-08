import { describe, expect, it } from "vitest";
import { remediationLimitEvidence, summarizeRemediationCycles, type RemediationCycleActivity, type RemediationCycleObservation } from "./remediation-cycle";
const error = (id: string, answerAt: number): RemediationCycleObservation => ({ id, rootId: id, answerAt,
  verifiedCorrect: "no", independentFailure: true, deliveredAssistance: false, verifiedErrorLabels: ["coefficients"] });
const chain = (): RemediationCycleActivity[] => [
  { id: "a", parentActivityId: null, identity: "scope/course/span/source-v1", originObservationId: null,
    observations: [error("failure-a", 10)], help: [] },
  { id: "b", parentActivityId: "a", identity: "scope/course/span/source-v1", originObservationId: "failure-a",
    observations: [{ ...error("helped-b", 30), independentFailure: false, deliveredAssistance: true }, error("failure-b", 40)],
    help: [{ id: "help-b", deliveredAt: 20, level: "hinted" }] },
  { id: "c", parentActivityId: "b", identity: "scope/course/span/source-v1", originObservationId: "failure-b",
    observations: [{ ...error("helped-c", 60), independentFailure: false, deliveredAssistance: true }],
    help: [{ id: "help-c", deliveredAt: 50, level: "revealed" }] },
];
describe("server remediation cycles", () => {
  it.each([0, 1, 2])("counts %i completed independent-failure/help/trusted-answer rounds", count => {
    const summary = summarizeRemediationCycles(chain().slice(0, count + 1));
    expect(summary.completedCycles).toHaveLength(count);
    expect(Boolean(remediationLimitEvidence(summary))).toBe(count === 2);
    if (count === 2) expect(remediationLimitEvidence(summary)).toEqual(expect.arrayContaining([
      "observation:failure-a", "help_exposure:help-b", "observation:helped-b", "observation:failure-b", "help_exposure:help-c", "observation:helped-c",
    ]));
  });
  it.each(["parent", "scope", "source", "skill"])("does not join a mixed %s chain", boundary => {
    const rows = chain();
    if (boundary === "parent") rows[2]!.parentActivityId = "unrelated";
    else rows[2]!.identity += boundary;
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
  });
  it("requires actual delivered help in temporal order, not a self-reported assistance flag", () => {
    for (const help of [[], [{ id: "late", deliveredAt: 70, level: "hinted" as const }], [{ id: "old", deliveredAt: 5, level: "hinted" as const }]]) {
      const rows = chain(); rows[2]!.help = help;
      expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
    }
  });
  it("does not turn unknowns, withdrawn heads or revised roots into additional failures", () => {
    for (const change of ["unknown", "retracted", "revision", "assisted-root"]) {
      const rows = chain();
      if (change === "unknown") rows[2]!.observations = [{ ...error("unknown", 60), verifiedCorrect: "unknown" }];
      if (change === "retracted") rows[1]!.observations = rows[1]!.observations.slice(0, 1);
      if (change === "revision") rows[1]!.observations = [rows[1]!.observations[0]!, { ...error("failure-b", 40), rootId: "failure-a" }];
      if (change === "assisted-root") rows[1]!.observations = [rows[1]!.observations[0]!, { ...error("failure-b", 40), independentFailure: false }];
      expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
    }
  });
  it("accepts helped correct followups without tags only when both rounds relied on delivered help", () => {
    const rows = chain();
    for (const activity of rows.slice(1)) activity.observations = activity.observations.map((row, i) => i === 0
      ? { ...row, verifiedCorrect: "yes", verifiedErrorLabels: [] } : row);
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).not.toBeNull();
    rows[2]!.observations = rows[2]!.observations.map(row => ({ ...row, deliveredAssistance: false }));
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
  });
  it("never treats AI labels as verified steps or unknown errors as strong failures", () => {
    const rows = chain();
    rows[2]!.observations = [{ ...error("c", 60), verifiedErrorLabels: [] }];
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
    rows[0]!.observations = [{ ...error("failure-a", 10), verifiedCorrect: "unknown" }];
    expect(summarizeRemediationCycles(rows).completedCycles).toHaveLength(0);
  });
  it("does not bridge a missing correction or keep the limit after an independent success", () => {
    const rows = chain();
    rows[1]!.help = [];
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
    const recovered = chain();
    recovered[2]!.observations = [...recovered[2]!.observations, { ...error("independent-success", 80), verifiedCorrect: "yes" }];
    expect(remediationLimitEvidence(summarizeRemediationCycles(recovered))).toBeNull();
  });
  it("requires the same verified label across both rounds when not persistently assisted", () => {
    const rows = chain();
    rows[2]!.observations = rows[2]!.observations.map(row => ({ ...row, deliveredAssistance: false }));
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).not.toBeNull();
    rows[1]!.observations = rows[1]!.observations.map(row => row.id === "failure-b" ? { ...row, verifiedErrorLabels: ["membership"] } : row);
    rows[2]!.observations = rows[2]!.observations.map(row => ({ ...row, verifiedErrorLabels: ["membership"] }));
    expect(remediationLimitEvidence(summarizeRemediationCycles(rows))).toBeNull();
  });
  it("reprojects a corrected head once rather than appending a new round", () => {
    const rows = chain();
    rows[2]!.observations = [{ ...rows[2]!.observations[0]!, id: "corrected-c", verifiedCorrect: "yes" }];
    const summary = summarizeRemediationCycles(rows);
    expect(summary.completedCycles).toHaveLength(2);
    expect(summary.completedCycles[1]!.evidenceRefs).toContain("observation:corrected-c");
    expect(summary.completedCycles[1]!.evidenceRefs).not.toContain("observation:helped-c");
  });
});
