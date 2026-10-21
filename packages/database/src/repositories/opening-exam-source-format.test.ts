import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EXAM_SPRINT_PACK as pack } from "@aistudy/domain/exam-sprint-catalog";
import { examPackDirectorySections, legacyExamPackSections } from "./opening-exam-source-format";
import { examSourceExposureCoverage, readExamSourceExposure } from "./opening-exam-source-exposure";
import type { LearningSql } from "./opening-learning-facts";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const sourceId = "00000000-0000-4000-8000-000000000001";
function fixture(sections: ReturnType<typeof examPackDirectorySections>, version = 0) {
  const chunks = sections.map((section, index) => ({ page: index + 1, text: section.text }));
  const body = sections.map(section => section.text).join("\n\n");
  const hash = createHash("sha256").update(body).digest("hex");
  const bytes = Buffer.byteLength(body);
  return { chunks, row: { pack_source_id: sourceId, current_version: version, source_version: String(version),
    mime: "text/plain", upload_state: "uploaded", parse_state: "ready", availability: "available",
    bytes, sha256: hash, version_bytes: bytes, version_sha256: hash } };
}
const read = (row: unknown, chunks: unknown[]) => {
  const query = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce(chunks);
  return readExamSourceExposure(query as unknown as LearningSql, scope, "sprint", pack);
};

describe("Sprint source content coverage boundary", () => {
  it("publishes an attributable metadata directory without full lesson bodies", () => {
    const sections = examPackDirectorySections(pack);
    expect(sections).toHaveLength(pack.lessons.length + 1);
    expect(sections[0]!.text).toContain("exam-sprint-directory-v1");
    for (const [index, lesson] of pack.lessons.entries()) {
      const section = sections[index + 1]!;
      expect(section.lessonId).toBe(lesson.id);
      expect(section.text).toContain(lesson.title);
      expect(section.text).toContain(lesson.summary);
      expect(section.text).toContain(pack.id);
      expect(section.text).toContain(pack.version);
      for (const teachingBody of [...lesson.steps, lesson.workedExample, ...lesson.pitfalls]) {
        expect(section.text).not.toContain(teachingBody);
      }
    }
  });
  it("retains the exact original legacy serialization without rewriting it as a directory", () => {
    const sections = legacyExamPackSections(pack);
    const item = pack.lessons[0]!;
    expect(sections[0]!.text).toBe(`${pack.title}\n\n${pack.description}\n\n${pack.limitations.join("\n")}`);
    expect(sections[1]!.text).toBe(`${item.title}\n\n${item.summary}\n\n${item.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n例题讲解\n${item.workedExample}\n\n易错点\n${item.pitfalls.join("\n")}`);
    expect(sections).not.toEqual(examPackDirectorySections(pack));
  });
  it.each([[0, "metadata_only"], [1, "unverifiable_source"]] as const)("classifies exact metadata at version %i as %s without claiming unverified earlier versions were safe", async (version, kind) => {
    const { row, chunks } = fixture(examPackDirectorySections(pack), version);
    const classification = await read(row, chunks);
    expect(classification).toEqual({ kind, packSourceId: sourceId, sourceVersion: version });
    // A later sanitized version does not erase an older, still downloadable full original.
    if (version === 0) expect(examSourceExposureCoverage(classification)).toBeUndefined();
    else expect(examSourceExposureCoverage(classification)?.kind).toBe("unverifiable_source");
  });
  it("captures the actual original legacy source identity, with no fabricated lesson receipt", async () => {
    const { row, chunks } = fixture(legacyExamPackSections(pack));
    const classification = await read(row, chunks);
    expect(classification).toEqual({ kind: "legacy_untracked_source", packSourceId: sourceId, sourceVersion: 0 });
    expect(examSourceExposureCoverage(classification)).toEqual(classification);
    expect(classification).not.toHaveProperty("openedAt");
  });
  it.each([
    { bytes: 1 }, { version_bytes: 1 }, { sha256: "bad" }, { version_sha256: "bad" },
    { availability: "unavailable" }, { current_version: 1 }, { mime: "application/pdf" },
  ])("keeps mismatched or unavailable evidence unknown: %j", async patch => {
    const { row, chunks } = fixture(examPackDirectorySections(pack));
    const result = await read({ ...row, ...patch }, chunks);
    expect(result).toEqual({ kind: "unverifiable_source", packSourceId: sourceId, sourceVersion: 0 });
    expect(examSourceExposureCoverage(result)?.kind).toBe("unverifiable_source");
  });
  it("does not infer metadata coverage from matching hashes of arbitrary or reordered content", async () => {
    const arbitrary = fixture([{ lessonId: null, title: "Directory", text: "Unreviewed original body" }]);
    expect((await read(arbitrary.row, arbitrary.chunks))?.kind).toBe("unverifiable_source");
    const { row, chunks } = fixture(examPackDirectorySections(pack));
    expect((await read(row, [...chunks].reverse()))?.kind).toBe("unverifiable_source");
    expect((await read(row, []))?.kind).toBe("unverifiable_source");
  });
  it("leaves an unbound Sprint alone without classifying ordinary materials", async () => {
    const query = vi.fn().mockResolvedValueOnce([]);
    expect(await readExamSourceExposure(query as unknown as LearningSql, scope, "sprint", pack)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(examSourceExposureCoverage(null)).toBeUndefined();
  });
});
