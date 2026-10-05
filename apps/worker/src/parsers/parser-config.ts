import path from "node:path";

export type ParserConfig = { pythonExecutable: string; cwd: string };

function repositoryRoot(launchCwd: string): string {
  const cwd = path.resolve(launchCwd);
  return path.basename(path.dirname(cwd)) === "apps" ? path.resolve(cwd, "../..") : cwd;
}

export function loadParserConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  launchCwd: string = process.cwd(),
): ParserConfig {
  if (env.NODE_ENV === "production" && (!env.PARSER_PYTHON || !env.PARSER_CWD)) {
    throw new Error("Production requires explicit PARSER_PYTHON and PARSER_CWD paths; see services/parser/README.md.");
  }
  const root = repositoryRoot(launchCwd);
  return {
    pythonExecutable: path.resolve(root, env.PARSER_PYTHON || `.local/docling-venv/${platform === "win32" ? "Scripts/python.exe" : "bin/python"}`),
    cwd: path.resolve(root, env.PARSER_CWD || "services/parser"),
  };
}
