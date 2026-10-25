import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat, mkdir, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ParserConfig } from "./parser-config";
import { homedir } from "node:os";

/** Content hash for small source/lock files; metadata for large immutable local
 * Python/model trees (size + mtime + ctime, including resolved symlinks). */
export async function parserFingerprint(config: ParserConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (file: string, contents = false, ancestors = new Set<string>()): Promise<void> => {
    hash.update(file);
    const resolved = await realpath(file);
    const info = await stat(file);
    hash.update(JSON.stringify([resolved, info.size, info.mtimeMs, info.ctimeMs]));
    if (info.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error("Parser fingerprint contains a symlink cycle");
      const next = new Set(ancestors).add(resolved);
      for (const name of (await readdir(file)).sort()) {
        if (name === "__pycache__" || name === ".pytest_cache") continue;
        await visit(path.join(file, name), contents, next);
      }
    } else if (contents) hash.update(await readFile(file));
  };
  // Establish that this is the configured parser installation before traversing
  // dependency/model trees. Invalid paths must not scan an unrelated system lib.
  await visit(path.join(config.cwd, "requirements-lock.txt"), true);
  await visit(path.join(config.cwd, "opening_parser"), true);
  await visit(config.pythonExecutable);
  // venv package installs/replacements must invalidate even if Python is unchanged.
  await visit(path.resolve(config.pythonExecutable, "../../lib"));
  const home = env.HOME || homedir();
  const cacheHome = env.XDG_CACHE_HOME || path.join(home, ".cache");
  const models = { HF_HOME: env.HF_HOME || path.join(cacheHome, "huggingface"),
    HF_HUB_CACHE: env.HF_HUB_CACHE, HUGGINGFACE_HUB_CACHE: env.HUGGINGFACE_HUB_CACHE,
    TRANSFORMERS_CACHE: env.TRANSFORMERS_CACHE, TORCH_HOME: env.TORCH_HOME || path.join(cacheHome, "torch"),
    PARSER_OCR_MODEL_DIR: env.PARSER_OCR_MODEL_DIR };
  for (const [key, directory] of Object.entries(models)) {
    hash.update(`${key}=${directory ?? ""}`);
    if (directory?.trim()) {
      try { await visit(path.resolve(directory)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("missing");
      }
    }
  }
  return hash.digest("hex");
}

export async function successfulPreflight(options: {
  file: string; ttlMs: number; fingerprint: () => Promise<string>; check: () => Promise<void>;
  force?: boolean; now?: () => number;
}): Promise<"cached" | "checked"> {
  const now = options.now ?? Date.now;
  let fingerprint: string | undefined;
  try { fingerprint = await options.fingerprint(); } catch { /* Cannot prove identity: run the real check. */ }
  if (fingerprint && !options.force && options.ttlMs > 0) {
    try {
      const cached = JSON.parse(await readFile(options.file, "utf8"));
      if (cached.version === 1 && cached.fingerprint === fingerprint && Number.isSafeInteger(cached.succeededAt)
        && cached.succeededAt <= now() && now() - cached.succeededAt < options.ttlMs) return "cached";
    } catch { /* Missing/corrupt receipts never suppress a real preflight. */ }
  }
  await rm(options.file, { force: true });
  await options.check(); // Never cache failures or replace success with a failure receipt.
  if (fingerprint && options.ttlMs > 0) {
    const temporary = `${options.file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(options.file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, fingerprint, succeededAt: now() }), { mode: 0o600 });
      await rename(temporary, options.file);
    } finally { await rm(temporary, { force: true }); }
  }
  return "checked";
}
