import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadParserConfig } from "./parser-config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("parser configuration", () => {
  it.each([["win32", "Scripts/python.exe"], ["linux", "bin/python"]] as const)("uses the %s development venv", (platform, suffix) => {
    expect(loadParserConfig({}, platform)).toEqual({
      pythonExecutable: path.resolve(root, ".local/docling-venv", suffix),
      cwd: path.resolve(root, "services/parser"),
    });
  });

  it("resolves explicit relative paths from the repository, independent of launch cwd", () => {
    expect(loadParserConfig({ PARSER_PYTHON: ".local/custom/bin/python", PARSER_CWD: "services/parser" })).toEqual({
      pythonExecutable: path.resolve(root, ".local/custom/bin/python"),
      cwd: path.resolve(root, "services/parser"),
    });
  });

  it("finds the repository when Node starts in the worker workspace", () => {
    const module = new URL("./parser-config.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { loadParserConfig } from ${JSON.stringify(module)}; console.log(JSON.stringify(loadParserConfig({})));`], {
      cwd: path.resolve(root, "apps/worker"), encoding: "utf8",
    });
    expect(JSON.parse(output).cwd).toBe(path.resolve(root, "services/parser"));
  });

  it("preserves explicit deployment paths", () => {
    const pythonExecutable = path.resolve("external/python");
    const cwd = path.resolve("external/parser");
    expect(loadParserConfig({ NODE_ENV: "production", PARSER_PYTHON: pythonExecutable, PARSER_CWD: cwd })).toEqual({ pythonExecutable, cwd });
  });

  it.each([{}, { PARSER_PYTHON: "/python" }, { PARSER_CWD: "/parser" }])("requires both deployment paths in production", (env) => {
    expect(() => loadParserConfig({ NODE_ENV: "production", ...env })).toThrow(/PARSER_PYTHON.*PARSER_CWD/);
  });
});

