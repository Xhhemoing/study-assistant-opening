import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verify } from "./pipeline-operations.mjs";
import { dryRun } from "./pipeline-dry-run.mjs";
import { createManifest } from "./state.mjs";

const pageUrl = "https://app.notion.com/p/Meeting-3e4f3b2fe60f808484fbd253954d12b9";
const blockId = "3e4f3b2f-e60f-8014-a407-d1be4488acce";

describe("pipeline operation recovery", () => {
  it("reuses a verified manifest after checking its transcript artifact", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-upload-verified-"));
    try {
      const artifactPath = path.join(workdir, "native-transcript.txt");
      const content = Buffer.from("0:00 Verified transcript\n");
      await writeFile(artifactPath, content);
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "verified";
      manifest.verification = {
        accepted: true,
        artifactPath,
        artifactBytes: content.length,
        artifactSha256: createHash("sha256").update(content).digest("hex"),
      };
      await expect( (await import("./pipeline-operations.mjs")).upload(
        { pageUrl, blockId, allowNonDisposable: false, allowRealTarget: false, dryRun: false },
        manifest,
        path.join(workdir, "manifest.json"),
      )).resolves.toBe(manifest);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects a verified manifest with incomplete transcript artifact metadata", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-verify-artifact-meta-"));
    try {
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "verified";
      manifest.verification = { accepted: true };
      await expect(verify({
        pageUrl,
        blockId,
        allowNonDisposable: false,
        allowRealTarget: false,
        dryRun: false,
      }, manifest, path.join(workdir, "manifest.json"))).rejects.toThrow(/transcript artifact/i);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("requires an upload task before opening the browser for verification", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-verify-state-"));
    try {
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      await expect(verify({
        pageUrl,
        blockId,
        allowNonDisposable: false,
        allowRealTarget: false,
        dryRun: false,
      }, manifest, path.join(workdir, "manifest.json"))).rejects.toThrow(/upload task/i);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects a dry-run when the persisted transcript artifact digest changed", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-dry-artifact-"));
    try {
      const artifactPath = path.join(workdir, "native-transcript.txt");
      await writeFile(artifactPath, "changed transcript\n", "utf8");
      const original = Buffer.from("0:00 Original transcript\n");
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "verified";
      manifest.verification = {
        accepted: true,
        artifactPath,
        artifactBytes: original.length,
        artifactSha256: createHash("sha256").update(original).digest("hex"),
      };
      const manifestPath = path.join(workdir, "manifest.json");
      const { saveManifestAtomic } = await import("./state.mjs");
      await saveManifestAtomic(manifestPath, manifest);
      await expect(dryRun({
        command: "verify",
        workdir,
        pageUrl,
        blockId,
        jobKey: "job",
        expectedDurationSeconds: 10,
        preparedPath: path.join(workdir, "prepared.m4a"),
        preparedPathExplicit: false,
        transcriptPath: path.join(workdir, "native-transcript.txt"),
        transcriptPathExplicit: false,
      })).rejects.toThrow(/digest|match/i);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("does not trust a verified transcript artifact after its digest changes", async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "notion-pipeline-verified-artifact-"));
    try {
      const artifactPath = path.join(workdir, "native-transcript.txt");
      await writeFile(artifactPath, "changed transcript\n", "utf8");
      const original = Buffer.from("0:00 Original transcript\n");
      const manifest = createManifest({ jobKey: "job", pageUrl, blockId, expectedDurationSeconds: 10 });
      manifest.stage = "verified";
      manifest.verification = {
        accepted: true,
        artifactPath,
        artifactBytes: original.length,
        artifactSha256: createHash("sha256").update(original).digest("hex"),
      };
      const args = {
        pageUrl,
        blockId,
        allowNonDisposable: false,
        allowRealTarget: false,
        dryRun: false,
      };
      await expect(verify(args, manifest, path.join(workdir, "manifest.json"))).rejects.toThrow(/digest|match/i);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
