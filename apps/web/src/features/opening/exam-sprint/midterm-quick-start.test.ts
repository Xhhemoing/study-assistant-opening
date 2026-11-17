import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { ExamMaterialBinding, SourceRecord } from "@aistudy/contracts";

const deps = vi.hoisted(() => ({
  exclude: vi.fn(), integrationRead: vi.fn(), bind: vi.fn(), sprintRead: vi.fn(), act: vi.fn(),
  listSources: vi.fn(), beginUpload: vi.fn(), putStaging: vi.fn(), completeUpload: vi.fn(),
  listCourses: vi.fn(), listAssets: vi.fn(), addAsset: vi.fn(), createCourse: vi.fn(),
}));
vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  createOpeningPrivacyRepository: () => ({ listExcludedSourceIds: deps.exclude }),
}));
vi.mock("./runtime", () => ({
  getExamIntegrationService: () => ({ read: deps.integrationRead, bind: deps.bind }),
  getExamSprintService: () => ({ read: deps.sprintRead, act: deps.act }),
}));
vi.mock("../sources/source-service", () => ({ createOpeningSourceService: () => deps }));

import type { AuthRuntime } from "../../auth/service";
import { startMidtermSprint } from "./midterm-quick-start";

const names = [
  ...Array.from({ length: 5 }, (_, index) => [
    `Topic_${index + 1}_Example_Test_to_Practice.pdf`, `Topic_${index + 1}_Example_Problems_to_Practice.pdf`,
  ]).flat(),
  "Basic notions_SLIDES.pdf", "Topic_2_Sequences_and_Limits_SLIDES.pdf", "Topic_3__Differential_Calculus_SLIDES.pdf",
  "Topic_4_Integral_Calculus_SLIDES.pdf", "Topic_5_Series_SLIDES.pdf",
];
const body = Buffer.from("%PDF-1.4\nSynthetic midterm source\n%%EOF\n");
const digest = createHash("sha256").update(body).digest("hex");
const principal = { userId: "owner", workspaceId: "workspace", sessionId: "session" };
const course = { id: "course-id", title: "高数期中 Topic 1–5", slug: "already-exists", archivedAt: null };
const runtime = { courses: { listCourses: deps.listCourses, getCourse: async () => ({ ...course, workspaceId: principal.workspaceId }),
  listCourseAssets: deps.listAssets, addAssetMembership: deps.addAsset, createCourse: deps.createCourse } } as unknown as AuthRuntime;
const sourceRecord = (id: string, name: string, parseState: SourceRecord["parseState"] = "ready") => ({
  id, name, bytes: body.length, mime: "application/pdf", sha256: digest, version: 0, uploadState: "uploaded", parseState,
}) as SourceRecord;

describe("midterm preparation", () => {
  let directory: string;
  let saved: SourceRecord[];
  let attached: Set<string>;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), "aistudy-midterm-"));
    await Promise.all(names.map(name => writeFile(join(directory, name), body)));
    saved = [];
    attached = new Set();
    deps.exclude.mockResolvedValue([]);
    deps.integrationRead.mockResolvedValue({ binding: null });
    deps.sprintRead.mockResolvedValue({ pack: EXAM_SPRINT_PACK, activeRun: null });
    deps.listCourses.mockResolvedValue([course]);
    deps.listSources.mockImplementation(async () => saved);
    deps.listAssets.mockImplementation(async () => saved.filter(source => attached.has(source.id)).map(source => ({ source })));
    deps.addAsset.mockImplementation(async ({ assetId }) => { attached.add(assetId); });
    deps.beginUpload.mockImplementation(async (_principal, { uploadId, name }) => {
      const source = sourceRecord(uploadId, name, "queued");
      saved.push(source);
      return { source };
    });
    deps.completeUpload.mockImplementation(async (_principal, id) => saved.find(source => source.id === id));
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("uploads fifteen once, waits for originals, then binds and enters the first Topic 1 practice", async () => {
    const [one, two] = await Promise.all([startMidtermSprint(runtime, principal, directory), startMidtermSprint(runtime, principal, directory)]);
    expect(one).toEqual({ pending: true });
    expect(two).toEqual(one);
    expect(saved.map(source => source.name)).toEqual(names);
    expect(attached.size).toBe(15);
    expect(deps.bind).not.toHaveBeenCalled();
    expect(deps.act).not.toHaveBeenCalled();
    saved.slice(0, 10).forEach(source => { source.parseState = "ready"; });
    expect(await startMidtermSprint(runtime, principal, directory)).toEqual({ courseId: course.id, href: `/opening/courses/${course.id}?mode=sprint` });
    expect(deps.beginUpload).toHaveBeenCalledTimes(15);
    expect(deps.bind.mock.calls[0]?.[1].materials.map((material: ExamMaterialBinding) => material.sourceTitle)).toEqual(names.slice(0, 10));
    expect(deps.act.mock.calls[0]?.[1]).toMatchObject({ action: "start", mode: "practice", topicId: "topic-1" });
  });

  it("preserves exclusion for an identical PDF uploaded manually under another name", async () => {
    saved.push({ ...sourceRecord("manual-id", "Renamed.pdf"), sha256: digest.toUpperCase() });
    deps.exclude.mockResolvedValue(["manual-id"]);
    await expect(startMidtermSprint(runtime, principal, directory)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(attached.size).toBe(0);
    expect(deps.beginUpload).not.toHaveBeenCalled();
  });

  it("retries an expired upload on a fresh identity and preserves the rejected receipt", async () => {
    expect(await startMidtermSprint(runtime, principal, directory)).toEqual({ pending: true });
    const original = saved[0]!;
    original.uploadState = "rejected";
    original.error = { code: "UPLOAD_TTL_EXPIRED", message: "expired", retryable: false };
    attached.delete(original.id);
    expect(await startMidtermSprint(runtime, principal, directory)).toEqual({ pending: true });
    const replacement = saved.at(-1)!;
    expect(saved).toHaveLength(16);
    expect(replacement).toMatchObject({ name: original.name, uploadState: "uploaded" });
    expect(replacement.id).not.toBe(original.id);
    expect(original.uploadState).toBe("rejected");
    expect(await startMidtermSprint(runtime, principal, directory)).toEqual({ pending: true });
    expect(saved).toHaveLength(16);
  });

  it("does not overwrite or accept a pin pointing to a different original", async () => {
    saved.push(sourceRecord("manual-id", "Other.pdf"));
    deps.integrationRead.mockResolvedValue({ binding: { courseId: course.id,
      materials: [{ sourceTitle: names[0], sourceId: "manual-id", sourceVersion: 0 }] } });
    await expect(startMidtermSprint(runtime, principal, directory)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("continues the active round without starting a new one", async () => {
    names.forEach((name, index) => saved.push(sourceRecord(`existing-${index}`, name)));
    deps.sprintRead.mockResolvedValue({ pack: EXAM_SPRINT_PACK, activeRun: { id: "active-practice" } });
    expect(await startMidtermSprint(runtime, principal, directory)).toHaveProperty("courseId", course.id);
    expect(deps.act).not.toHaveBeenCalled();
  });
});
