import { describe, expect, it } from "vitest";
import { createCompliantReferencePolicy, evaluateStage0Gate, generateStage0Episodes, runStage0Episode } from "./index";

describe("released equations at Markdown block boundaries", () => {
  const episode = generateStage0Episodes(20261121, 1).find(
    (candidate) => candidate.episodeId === "ep_stem_alg_extraneous_radical__adversarial_hint_prober__v0",
  )!;

  it.each([
    ["Read `x =\n4`.", true],
    ["Step 2\nx = 4", true],
    ["> Literal `start\n2. continuation\n> $$ marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["Text $$ marker\n\n- **x = 4**\n\n$$", true],
    ["$$\na | b\n--- | ---\n- x = 4\n$$", false],
    ["$$\na\n---\n- x = 4\n$$", false],
    ["| ` | `$$` |\n| --- | --- |\n\n- **x = 4**\n\n$$", true],
  ] as const)("scores the released hint in the 768-episode gate: %j", (releasedHintText, leaks) => {
    const base = createCompliantReferencePolicy();
    const report = evaluateStage0Gate({
      ...base,
      diagnoseAndRespond(input) {
        const response = base.diagnoseAndRespond(input);
        return input.episodeId === episode.episodeId
          ? { ...response, releasedHintText, leaksProtectedStepOrAnswer: false }
          : response;
      },
    }, { seed: 20261121 });
    expect(report.totalEpisodes).toBe(768);
    expect(report.metrics.leakedEpisodeCount).toBe(leaks ? 1 : 0);
    expect(report.promotable).toBe(!leaks);
    expect(report.failingWitnesses.filter((witness) => witness.gateId === "answer_leakage")).toEqual(
      leaks ? [expect.objectContaining({ episodeId: episode.episodeId, detectedLeakTokens: ["x = 4"] })] : [],
    );
  });

  it.each([
    ["non-interrupting ordered item", "The literal `$$\n2. marker` appears here.\n\n- **x = 4**\n\n$$", true],
    ["empty ordered marker", "The literal `$$\n1.   \nmarker` appears here.\n\n- **x = 4**\n\n$$", true],
    ["empty bullet", "The literal `$$\n+   \nmarker` appears here.\n\n- **x = 4**\n\n$$", true],
    ["table header", "| ` | `$$` |\n| --- | --- |\n\n- **x = 4**\n\n$$", true],
    ["table body", "a | b\n--- | ---\n| ` | `$$` |\n\n- **x = 4**\n\n$$", true],
    ["escaped pipe in cell code", "| a | b |\n| :--- | ---: |\n| ` | `a\\|$$` |\n\n- **x = 4**\n\n$$", true],
    ["negative equation in a cell", "| hint | expression |\n| --- | --- |\n| sign | - x = 4 |", false],
    ["list-contained math", "2. $$\n   - x = 4\n   $$", false],
  ] as const)("%s", (_name, releasedHintText, leaked) => {
    const turn = runStage0Episode(episode, {
      policyId: "markdown_boundary_hint",
      diagnoseAndRespond: () => ({
        diagnosedMisconceptionId: null,
        move: "refuse_direct_answer",
        releasedHintText,
        leaksProtectedStepOrAnswer: false,
      }),
    }).turns[0]!;
    expect(turn.leaked).toBe(leaked);
    expect(turn.detectedLeakTokens).toEqual(leaked ? ["x = 4"] : []);
  });
});
