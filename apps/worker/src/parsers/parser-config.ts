import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export type ParserConfig = { pythonExecutable: string; cwd: string };

export function loadParserConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ParserConfig {
  if (env.NODE_ENV === "production" && (!env.PARSER_PYTHON || !env.PARSER_CWD)) {
    throw new Error("Production requires explicit PARSER_PYTHON and PARSER_CWD paths; see services/parser/README.md.");
  }
  return {
    pythonExecutable: path.resolve(root, env.PARSER_PYTHON || `.local/docling-venv/${platform === "win32" ? "Scripts/python.exe" : "bin/python"}`),
    cwd: path.resolve(root, env.PARSER_CWD || "services/parser"),
  };
}
