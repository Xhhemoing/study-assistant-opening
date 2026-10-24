import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parserFingerprint, successfulPreflight } from "./preflight-cache";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(file => rm(file, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "parser-success-")); directories.push(dir);
  let now = 1000;
  const options = { file: path.join(dir, "success.json"), ttlMs: 100, now: () => now,
    fingerprint: vi.fn(async () => "python-lock-code-models-v1"), check: vi.fn(async () => {}) };
  return { dir, options, advance: () => { now += 100; } };
}
describe("successful parser preflight cache", () => {
  it("reuses only unexpired success with identical fingerprint; force and changes rerun", async () => {
    const { options, advance } = await fixture();
    expect(await successfulPreflight(options)).toBe("checked");
    expect(await successfulPreflight(options)).toBe("cached");
    advance(); expect(await successfulPreflight(options)).toBe("checked");
    options.fingerprint.mockResolvedValue("changed-python-lock-code-or-model");
    expect(await successfulPreflight(options)).toBe("checked");
    expect(await successfulPreflight({ ...options, force: true })).toBe("checked");
    expect(options.check).toHaveBeenCalledTimes(4);
  });
  it("corrupt receipt and unknown fingerprint run real checks; failures never persist", async () => {
    const { options } = await fixture();
    await writeFile(options.file, "broken json");
    expect(await successfulPreflight(options)).toBe("checked");
    options.check.mockRejectedValueOnce(new Error("broken import"));
    await expect(successfulPreflight({ ...options, force: true })).rejects.toThrow("broken import");
    await expect(readFile(options.file)).rejects.toThrow();
    options.fingerprint.mockRejectedValue(new Error("missing model directory"));
    expect(await successfulPreflight(options)).toBe("checked");
    await expect(readFile(options.file)).rejects.toThrow();
  });
  it("TTL zero disables reuse and persistence", async () => {
    const { options } = await fixture(); options.ttlMs = 0;
    await successfulPreflight(options); await successfulPreflight(options);
    expect(options.check).toHaveBeenCalledTimes(2);
    await expect(readFile(options.file)).rejects.toThrow();
  });
  it("fingerprints Python, installed dependencies, lock, parser code and model files", async () => {
    const { dir } = await fixture();
    const files = ["venv/bin/python", "venv/lib/site-packages/dep.py", "parser/requirements-lock.txt", "parser/opening_parser/__main__.py", "models/model.bin"];
    for (const file of files) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), "initial");
    }
    const config = { pythonExecutable: path.join(dir, files[0]!), cwd: path.join(dir, "parser") };
    const env = { HOME: dir, HF_HOME: path.join(dir, "models") } as NodeJS.ProcessEnv;
    let before = await parserFingerprint(config, env);
    expect(await parserFingerprint(config, env)).toBe(before);
    for (const file of files) {
      await writeFile(path.join(dir, file), "updated with different size");
      const after = await parserFingerprint(config, env);
      expect(after).not.toBe(before); before = after;
    }
  });
});
