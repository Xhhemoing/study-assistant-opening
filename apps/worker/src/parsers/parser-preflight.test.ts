import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightParser } from "./parser-preflight";
import { main } from "../index";

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder() {
  const value = await mkdtemp(path.join(os.tmpdir(), "parser-preflight-"));
  folders.push(value);
  return value;
}

describe("parser startup preflight", () => {
  it("identifies a missing executable and its setting", async () => {
    const cwd = await folder();
    await expect(preflightParser({ cwd, pythonExecutable: path.join(cwd, "missing-python") })).rejects.toThrow(/PARSER_PYTHON.*missing-python/);
  });

  it("identifies a missing parser directory and its setting", async () => {
    await expect(preflightParser({ cwd: path.join(await folder(), "missing-parser"), pythonExecutable: process.execPath })).rejects.toThrow(/PARSER_CWD.*missing-parser/);
  });

  it("reports a real failing dependency command with install guidance", async () => {
    await expect(preflightParser({ cwd: await folder(), pythonExecutable: process.execPath })).rejects.toThrow(/opening_parser --check.*requirements-lock\.txt/s);
  });

  it("rejects worker startup before attempting Redis or database connections", async () => {
    vi.stubEnv("PARSER_PYTHON", process.execPath);
    vi.stubEnv("PARSER_CWD", path.join(await folder(), "missing-parser"));
    vi.stubEnv("REDIS_URL", "not-a-redis-url");
    vi.stubEnv("DATABASE_URL", "not-a-postgres-url");
    await expect(main()).rejects.toThrow(/PARSER_CWD/);
  });
});
