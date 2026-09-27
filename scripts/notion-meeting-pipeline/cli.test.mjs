import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatStatus,
  main,
  parseArgs,
  resolveManifestPath,
} from "../notion-meeting-pipeline.mjs";
import { ensureTarget } from "./cli-options.mjs";
import { assertManifestIdentity } from "./pipeline-validation.mjs";
import { createManifest, loadManifest, saveManifestAtomic } from "./state.mjs";

describe("notion meeting pipeline CLI", () => {
  it("accepts --help before or after a subcommand without serializing a source URL", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["run", "--help"]).command).toBe("help");
    const args = parseArgs(["run", "--help", "--source-url", "https://cdn.example.test/audio.mp4?signature=secret-value"]);
    expect(JSON.stringify(args)).not.toContain("secret-value");
  });

  it("canonicalizes the target URL before it becomes manifest identity", () => {
    const args = {
      pageUrl: "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676?from=test#notes",
      blockId: "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
      allowNonDisposable: false,
      allowRealTarget: false,
    };
    expect(ensureTarget(args).pageUrl).toBe("https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676");
    expect(args.pageUrl).toBe("https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676");
  });

  it("allows a run to resume from an existing manifest without a new source URL", () => {
    const args = parseArgs([
      "run",
      "--job-key", "job",
      "--expected-duration-seconds", "10",
      "--page-url", "https://app.notion.com/p/Meeting-3e2f3b2fe60f806b8717dcaef7c11676",
      "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    ]);
    expect(args.source).toBeNull();
    expect(args.sourceUrl).toBeNull();
  });

  it("compares persisted page identity after canonicalizing query and hash", () => {
    const args = parseArgs([
      "upload", "--job-key", "job", "--expected-duration-seconds", "10",
      "--page-url", "https://app.notion.com/p/Meeting-3e2f3b2fe60f8030b458f3541f2b669c?new=1#tab",
      "--block-id", "3e2f3b2f-e60f-800a-9b94-e9b499ed3a4e",
    ]);
    expect(() => assertManifestIdentity({
      jobKey: "job",
      pageUrl: "https://app.notion.com/p/Meeting-3e2f3b2fe60f8030b458f3541f2b669c?old=1",
      blockId: args.blockId,
      expectedDurationSeconds: 10,
    }, args)).not.toThrow();
  });

  it("adopts a persisted transcript artifact path when a resume command omits the path override", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-transcript-identity-"));
    try {
      const pageUrl = "https://app.notion.com/p/Meeting-3e2f3b2fe60f8030b458f3541f2b669c";
      const blockId = "3e2f3b2f-e60f-800a-9b94-e9b499ed3a4e";
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "verified";
      manifest.verification = {
        accepted: true,
        artifactPath: path.join(workdir, "operator-transcript.txt"),
        artifactBytes: 1,
        artifactSha256: "a".repeat(64),
      };
      await saveManifestAtomic(path.join(workdir, "manifest.json"), manifest);
      const args = parseArgs([
        "verify", "--job-key", "job", "--expected-duration-seconds", "10",
        "--page-url", pageUrl, "--block-id", blockId, "--workdir", workdir,
      ]);
      assertManifestIdentity(await loadManifest(path.join(workdir, "manifest.json")), args);
      expect(args.transcriptPath).toBe(path.resolve(manifest.verification.artifactPath));
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("adopts a persisted prepared path when a resume command omits the path override", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-prepared-identity-"));
    try {
      const pageUrl = "https://app.notion.com/p/Meeting-3e2f3b2fe60f8030b458f3541f2b669c";
      const blockId = "3e2f3b2f-e60f-800a-9b94-e9b499ed3a4e";
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "prepared";
      manifest.prepared = { path: path.join(workdir, "operator-prepared.m4a"), bytes: 1, sha256: "a", durationSeconds: 10 };
      await saveManifestAtomic(path.join(workdir, "manifest.json"), manifest);
      const args = parseArgs([
        "upload", "--job-key", "job", "--expected-duration-seconds", "10",
        "--page-url", pageUrl, "--block-id", blockId, "--workdir", workdir,
      ]);
      assertManifestIdentity(await loadManifest(path.join(workdir, "manifest.json")), args);
      expect(args.preparedPath).toBe(path.resolve(manifest.prepared.path));
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("requires a pinned hash when a remote source URL is used", () => {
    expect(() => parseArgs([
      "prepare", "--job-key", "job", "--source-url", "https://cdn.example.test/audio.mp4",
      "--expected-duration-seconds", "10",
      "--page-url", "https://app.notion.com/p/Meeting-3e2f3b2fe60f806b8717dcaef7c11676",
      "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    ])).toThrow(/source-sha256/i);
  });

  it("parses a recoverable run configuration without exposing source URL values", () => {
    const args = parseArgs([
      "run",
      "--job-key", "zhixue:163730:6108854:teacher",
      "--source-url", "https://cdn.example.test/audio.mp4?signature=secret-value",
      "--source-sha256", "a".repeat(64),
      "--expected-duration-seconds", "5955",
      "--page-url", "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
      "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    ]);
    expect(args).toMatchObject({
      command: "run",
      jobKey: "zhixue:163730:6108854:teacher",
      expectedDurationSeconds: 5955,
      pageUrl: "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
    });
    expect(JSON.stringify(args)).not.toContain("secret-value");
  });

  it("rejects malformed source hashes before creating a job", () => {
    expect(() => parseArgs(["prepare", "--job-key", "job", "--source", "a.mp4", "--source-sha256", "not-a-hash", "--expected-duration-seconds", "10", "--page-url", "https://app.notion.com/p/Meeting-3e2f3b2fe60f806b8717dcaef7c11676", "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527"])).toThrow(/sha256|hash/i);
  });

  it("does not create or fail a manifest during a dry-run validation error", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-dry-run-"));
    try {
      const result = await main(["prepare", "--job-key", "job", "--source", path.join(workdir, "missing.mp4"), "--expected-duration-seconds", "10", "--page-url", "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676", "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527", "--workdir", workdir, "--dry-run"]);
      expect(result).toBe(1);
      await expect(loadManifest(resolveManifestPath({ workdir }))).resolves.toBeNull();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("does not create a workdir when target URL policy rejects the command", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-target-policy-"));
    await rm(workdir, { recursive: true, force: true });
    try {
      const result = await main([
        "prepare", "--job-key", "job", "--source", path.join(workdir, "missing.mp4"),
        "--expected-duration-seconds", "10", "--page-url", "https://example.com/notion",
        "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527", "--workdir", workdir,
      ]);
      expect(result).toBe(1);
      await expect(stat(workdir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("persists a sanitized failed stage so a later run can recover", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-cli-"));
    try {
      const result = await main(["prepare", "--job-key", "job", "--source", path.join(workdir, "missing.mp4"), "--expected-duration-seconds", "10", "--page-url", "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676", "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527", "--workdir", workdir]);
      expect(result).toBe(1);
      const manifest = await loadManifest(resolveManifestPath({ workdir }));
      expect(manifest).toMatchObject({ stage: "failed" });
      expect(JSON.stringify(manifest)).not.toMatch(/Bearer|secret|token/i);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects conflicting source inputs and malformed durations", () => {
    expect(() => parseArgs(["prepare", "--job-key", "job", "--source", "a.mp4", "--source-url", "https://example.test/a.mp4", "--expected-duration-seconds", "10"])).toThrow(/source/i);
    expect(() => parseArgs(["prepare", "--job-key", "job", "--source", "a.mp4", "--expected-duration-seconds", "0"])).toThrow(/duration/i);
  });

  it("derives a manifest path from the work directory and job key", () => {
    expect(resolveManifestPath({ jobKey: "zhixue:163730:6108854:teacher", workdir: ".tmp/pipeline" })).toMatch(/\.tmp[\\/]pipeline[\\/]manifest\.json$/);
  });

  it("does not mark an unrelated manifest failed after an argument mismatch", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-identity-"));
    try {
      const first = [
        "prepare", "--job-key", "job-a", "--source", path.join(workdir, "missing-a.mp4"),
        "--expected-duration-seconds", "10", "--page-url", "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
        "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527", "--workdir", workdir,
      ];
      expect(await main(first)).toBe(1);
      const before = await loadManifest(resolveManifestPath({ workdir }));
      expect(before.stage).toBe("failed");
      const second = [
        "prepare", "--job-key", "job-b", "--source", path.join(workdir, "missing-b.mp4"),
        "--expected-duration-seconds", "10", "--page-url", "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
        "--block-id", "3e3f3b2f-e60f-803e-b05f-de720f6b9527", "--workdir", workdir,
      ];
      expect(await main(second)).toBe(1);
      const after = await loadManifest(resolveManifestPath({ workdir }));
      expect(after.jobKey).toBe("job-a");
      expect(after.error).toBe(before.error);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("does not mark a manifest failed after a prepared-path identity mismatch", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-prepared-mismatch-"));
    try {
      const pageUrl = "https://app.notion.com/p/Meeting-3e3f3b2fe60f8030b458f3541f2b669c";
      const blockId = "3e2f3b2f-e60f-800a-9b94-e9b499ed3a4e";
      const manifest = (await import("./state.mjs")).createManifest({
        jobKey: "job",
        pageUrl,
        blockId,
        expectedDurationSeconds: 10,
      });
      manifest.stage = "prepared";
      manifest.prepared = {
        path: path.join(workdir, "actual.m4a"),
        bytes: 1,
        sha256: "a".repeat(64),
        durationSeconds: 10,
      };
      await (await import("./state.mjs")).saveManifestAtomic(resolveManifestPath({ workdir }), manifest);
      const result = await main([
        "prepare", "--job-key", "job", "--source", path.join(workdir, "missing.mp4"),
        "--expected-duration-seconds", "10", "--page-url", pageUrl, "--block-id", blockId,
        "--prepared-path", path.join(workdir, "wrong.m4a"), "--workdir", workdir,
      ]);
      expect(result).toBe(1);
      await expect(loadManifest(resolveManifestPath({ workdir }))).resolves.toMatchObject({ stage: "prepared" });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("formats status with redacted operational fields", () => {
    const output = formatStatus({
      version: 1,
      jobKey: "job",
      stage: "queued",
      updatedAt: "2026-09-22T00:00:00.000Z",
      source: { bytes: 12, sha256: "a".repeat(64), path: "source.mp4" },
      prepared: { bytes: 10, sha256: "b".repeat(64), path: "prepared.m4a", durationSeconds: 10 },
      notion: { taskId: "task-1234567890", taskState: "in_progress" },
      error: "Authorization: Bearer secret_value",
    });
    expect(output).toMatchObject({ stage: "queued", sourceBytes: 12, preparedBytes: 10, taskState: "in_progress" });
    expect(JSON.stringify(output)).not.toMatch(/secret_value|Bearer|authorization/i);
  });
});
