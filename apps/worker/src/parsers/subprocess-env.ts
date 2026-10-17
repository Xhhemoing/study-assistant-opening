// Parsers handle untrusted files. Pass only runtime paths and local model
// settings; never copy application credentials or executable loader hooks.
const runtimeKeys = new Set([
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR",
  "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
]);
const pythonKeys = new Set([
  "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE",
  "TORCH_HOME", "XDG_CACHE_HOME", "PARSER_OCR_MODEL_DIR",
  "OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS",
  "VECLIB_MAXIMUM_THREADS", "TOKENIZERS_PARALLELISM", "CUDA_VISIBLE_DEVICES",
]);

export function createParserSubprocessEnv(
  kind: "python" | "media",
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    // Windows environment variable names are case-insensitive (e.g. Path,
    // SystemRoot); preserve their spelling without widening the allowlist.
    const normalized = process.platform === "win32" ? key.toUpperCase() : key;
    if (value !== undefined && (runtimeKeys.has(normalized) || kind === "python" && pythonKeys.has(normalized))) {
      env[key] = value;
    }
  }
  if (kind === "python") {
    env.PYTHONIOENCODING = "utf-8";
    env.PYTHONNOUSERSITE = "1";
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
    env.HF_HUB_DISABLE_IMPLICIT_TOKEN = "1";
  } else {
    env.AV_LOG_FORCE_NOCOLOR = "1";
  }
  // Next augments ProcessEnv with a required NODE_ENV, but Node accepts an
  // explicit child environment without application-specific variables.
  return env as NodeJS.ProcessEnv;
}
