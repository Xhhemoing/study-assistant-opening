import { describe, expect, it } from "vitest";
import { chaptersFirst, nextStepCopy, nextStepCta } from "./course-knowledge";
import { evidenceTargetsForNode } from "./knowledge-evidence";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("course-knowledge helpers", () => {
  it("orders chapters before concepts and never invents mastery copy", () => {
    const ordered = chaptersFirst([
      { id: id(1), courseId: id(9), label: "概念", kind: "concept", evidenceChunkIds: [], status: "suggested" },
      { id: id(2), courseId: id(9), label: "第一章", kind: "chapter", evidenceChunkIds: [id(3)], status: "supported" },
    ]);
    expect(ordered[0]?.kind).toBe("chapter");
    expect(nextStepCopy([])).toMatch(/章节/);
    expect(nextStepCopy([{ reason: "先做独立变式" }])).toBe("先做独立变式");
  });

  it("builds material / video / problem targets without dead #evidence-* hashes (CT-04)", () => {
    const targets = evidenceTargetsForNode({
      id: id(1),
      courseId: id(9),
      label: "题型A",
      kind: "problem_type",
      evidenceChunkIds: [id(4)],
    });
    expect(targets.some((t) => t.kind === "material")).toBe(true);
    expect(targets.some((t) => t.kind === "problem")).toBe(true);
    expect(targets.some((t) => t.kind === "evidence")).toBe(true);
    expect(targets.some((t) => t.kind === "video")).toBe(true);
    expect(targets.every((t) => !t.href || !t.href.includes("#evidence-"))).toBe(true);
    const video = targets.find((t) => t.kind === "video");
    expect(video?.label).toContain("仅打开材料库，暂不能定位");
    expect(video && "canSeek" in video ? video.canSeek : true).toBe(false);
    const evidence = targets.find((t) => t.kind === "evidence");
    expect(evidence?.href).toBeNull();
    expect(evidence?.label).toMatch(/当前页无法定位到片段/);
    expect(evidence?.label).not.toContain(id(4));
  });

  it("seeks course media when source + startMs are known (CT-04)", () => {
    const targets = evidenceTargetsForNode(
      {
        id: id(1),
        courseId: id(9),
        label: "概念",
        kind: "concept",
        evidenceChunkIds: [],
      },
      {
        courseMediaAvailable: true,
        videoSourceId: id(7),
        videoStartMs: 12500,
      },
    );
    const video = targets.find((t) => t.kind === "video");
    expect(video?.canSeek).toBe(true);
    expect(video?.href).toContain("mediaSource=");
    expect(video?.href).toContain("seekMs=12500");
    expect(video?.href).toContain("#course-media");
  });

  it("retains complete evidence identities only for diagnostics without creating a false locator", () => {
    const targets = evidenceTargetsForNode({ id: id(1), courseId: id(9), label: "概念", kind: "concept", evidenceChunkIds: [id(4)] }, { diagnostics: true });
    const evidence = targets.find(target => target.kind === "evidence");
    expect(evidence?.label).toContain(id(4));
    expect(evidence?.href).toBeNull();
  });

  it("opens course media without fake seek when media panel exists but no segment (CT-04)", () => {
    const targets = evidenceTargetsForNode(
      { id: id(1), courseId: id(9), label: "概念", kind: "concept", evidenceChunkIds: [] },
      { courseMediaAvailable: true },
    );
    const video = targets.find((t) => t.kind === "video");
    expect(video?.href).toContain("#course-media");
    expect(video?.label).toMatch(/暂不能自动定位/);
    expect(video?.canSeek).toBe(false);
  });

  it("makes the first tutor action a clickable practice CTA (CT-05)", () => {
    expect(nextStepCta(null)).toBeNull();
    const practice = nextStepCta({
      kind: "independent_variant",
      skillLabel: "链式法则",
      reason: "先做一道独立变式",
    });
    expect(practice?.href).toContain("skillLabel=");
    expect(practice?.href).toContain("#course-practice");
    expect(practice?.label).toMatch(/独立变式/);
    const clarify = nextStepCta({
      kind: "clarify",
      skillLabel: "导数",
      reason: "先选定材料页",
    });
    expect(clarify?.href).toBe("#course-assets");
  });
});
