import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManifest,
  loadManifest,
  saveManifestAtomic,
  withFileLock,
} from "./state.mjs";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "notion-pipeline-test-"));
}

describe("recoverable pipeline state", () => {
  it("round-trips a manifest through an atomic write", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "job.json");
      const manifest = createManifest({
        jobKey: "zhixue:163730:6108854:teacher",
        pageUrl: "https://app.notion.com/p/Meeting-test",
        blockId: "11111111-1111-4111-8111-111111111111",
      });
      manifest.stage = "prepared";
      await saveManifestAtomic(file, manifest);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        version: 1,
        jobKey: manifest.jobKey,
        stage: "prepared",
      });
      expect(await loadManifest(file)).toMatchObject({
        jobKey: manifest.jobKey,
        stage: "prepared",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing manifest on every atomic checkpoint", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "job.json");
      const manifest = createManifest({ jobKey: "job" });
      await saveManifestAtomic(file, manifest);
      manifest.stage = "source_ready";
      await saveManifestAtomic(file, manifest);
      await expect(loadManifest(file)).resolves.toMatchObject({ stage: "source_ready" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent atomic checkpoints parseable", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "job.json");
      const writes = Array.from({ length: 12 }, (_, index) => saveManifestAtomic(file, {
        ...createManifest({ jobKey: `job-${index}` }),
        stage: "source_ready",
      }));
      await expect(Promise.all(writes)).resolves.toHaveLength(12);
      await expect(loadManifest(file)).resolves.toMatchObject({ stage: "source_ready" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a concurrent writer and releases the lock after completion", async () => {
    const dir = await tempDir();
    try {
      const lock = path.join(dir, "job.lock");
      await withFileLock(lock, async () => {
        await expect(withFileLock(lock, async () => "never")).rejects.toThrow(/locked/i);
      });
      await expect(withFileLock(lock, async () => "released")).resolves.toBe("released");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims an old lock only when its recorded owner is no longer alive", async () => {
    const dir = await tempDir();
    try {
      const lock = path.join(dir, "stale.lock");
      await writeFile(lock, JSON.stringify({ pid: 99_999_999, createdAt: "2000-01-01T00:00:00.000Z", token: "dead-owner-token" }), "utf8");
      const old = (Date.now() - 60_000) / 1000;
      await utimes(lock, old, old);
      await expect(withFileLock(lock, async () => "reclaimed", { staleAfterMs: 100 })).resolves.toBe("reclaimed");

      await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z", token: "live-owner-token" }), "utf8");
      await utimes(lock, old, old);
      await expect(withFileLock(lock, async () => "unsafe", { staleAfterMs: 100 })).rejects.toThrow(/locked/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows only one contender to reclaim the same stale lock", async () => {
    const dir = await tempDir();
    try {
      const lock = path.join(dir, "race.lock");
      await writeFile(lock, JSON.stringify({ pid: 99_999_999, createdAt: "2000-01-01T00:00:00.000Z", token: "dead-race-owner-token" }), "utf8");
      const old = (Date.now() - 60_000) / 1000;
      await utimes(lock, old, old);
      const results = await Promise.allSettled([
        withFileLock(lock, async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return "winner";
        }, { staleAfterMs: 100 }),
        withFileLock(lock, async () => "loser", { staleAfterMs: 100 }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      expect(fulfilled).toHaveLength(1);
      expect(["winner", "loser"]).toContain(fulfilled[0]);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(withFileLock(lock, async () => "released")).resolves.toBe("released");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reclaim an old lock whose owner token is missing", async () => {
    const dir = await tempDir();
    try {
      const lock = path.join(dir, "missing-token.lock");
      await writeFile(lock, JSON.stringify({ pid: 99_999_999, createdAt: "2000-01-01T00:00:00.000Z" }), "utf8");
      const old = (Date.now() - 60_000) / 1000;
      await utimes(lock, old, old);
      await expect(withFileLock(lock, async () => "unsafe", { staleAfterMs: 100 })).rejects.toThrow(/locked/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reclaim an old lock whose owner metadata is malformed", async () => {
    const dir = await tempDir();
    try {
      const lock = path.join(dir, "malformed.lock");
      await writeFile(lock, "", "utf8");
      const old = (Date.now() - 60_000) / 1000;
      await utimes(lock, old, old);
      await expect(withFileLock(lock, async () => "unsafe", { staleAfterMs: 100 })).rejects.toThrow(/locked/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed manifests instead of silently starting a duplicate job", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "bad.json");
      await writeFile(file, JSON.stringify({ version: 999, stage: "unknown" }), "utf8");
      await expect(loadManifest(file)).rejects.toThrow(/manifest/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a versioned manifest without the persisted Notion state object", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "missing-notion.json");
      const manifest = createManifest({ jobKey: "job" });
      delete manifest.notion;
      await writeFile(file, JSON.stringify(manifest), "utf8");
      await expect(loadManifest(file)).rejects.toThrow(/manifest\.notion/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
