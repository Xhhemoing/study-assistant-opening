import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { deriveTypecheckSet, tscArgs } from "../../scripts/typecheck.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web");
function parse(file) {
  const config = ts.readConfigFile(file, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file));
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

test("dynamic workspace discovery selects the Web solution without losing other gates", () => {
  const tasks = deriveTypecheckSet(root);
  assert.equal(tasks.length, 10);
  const task = tasks.find((entry) => entry.cwd === "apps/web");
  assert.equal(task.project, "tsconfig.typecheck.json");
  assert.equal(task.mode, "build");
  assert.deepEqual(tscArgs(task), ["-b", "tsconfig.typecheck.json", "--stopBuildOnErrors"]);
  for (const entry of tasks.filter((entry) => entry !== task)) {
    assert.deepEqual(tscArgs(entry), ["-p", entry.project, "--noEmit"]);
  }
});

test("solution roots retain the previous Web inputs, generated types and source aliases", () => {
  const product = parse(path.join(web, "tsconfig.json"));
  const tests = parse(path.join(web, "tsconfig.tests.json"));
  const solution = parse(path.join(web, "tsconfig.typecheck.json"));
  assert.deepEqual(solution.fileNames, []);
  assert.deepEqual(solution.projectReferences.map((r) => r.path), [path.join(web, "tsconfig.json"), path.join(web, "tsconfig.tests.json")]);
  const legacy = ts.readConfigFile(path.join(web, "tsconfig.json"), ts.sys.readFile).config;
  legacy.exclude = ["node_modules", "src/**/*.test.ts"];
  const previous = ts.parseJsonConfigFileContent(legacy, ts.sys, web);
  const union = new Set([...product.fileNames, ...tests.fileNames]);
  for (const file of previous.fileNames) assert.ok(union.has(file), `lost input: ${file}`);
  assert.ok(tests.fileNames.some((file) => file.endsWith(".test.ts")));
  for (const config of [product, tests]) {
    assert.ok(config.raw.include.includes(".next/types/**/*.ts"));
    assert.equal(config.options.noEmit, true);
    assert.equal(config.options.incremental, true);
    assert.deepEqual(config.options.paths, product.options.paths);
  }
  assert.notEqual(product.options.tsBuildInfoFile, tests.options.tsBuildInfoFile);
});

test("solution build checks independent noEmit leaves, warm edits and imported dependency errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-solution-"));
  const put = (name, value) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  };
  const build = () => spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), ...tscArgs({ mode: "build", project: "solution.json" })], { cwd: dir, encoding: "utf8" });
  try {
    put("solution.json", { files: [], references: [{ path: "product.json" }, { path: "tests.json" }] });
    for (const name of ["product", "tests"]) put(`${name}.json`, {
      compilerOptions: { strict: true, noEmit: true, incremental: true, types: [], skipLibCheck: true, tsBuildInfoFile: `${name}.tsbuildinfo` },
      files: [name === "product" ? "src/index.ts" : "src/index.test.ts", ".next/types/routes.ts"],
    });
    put("dep/index.ts", "export const value: number = 1;\n");
    put("src/index.ts", "export { value } from '../dep/index';\n");
    put("src/index.test.ts", "import { value } from './index'; const checked: number = value;\n");
    put(".next/types/routes.ts", "export {};\n");
    assert.equal(build().status, 0);
    put("src/index.test.ts", "import { value } from './index'; const checked: string = value;\n");
    let result = build();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /TS2322/);
    put("src/index.test.ts", "export {};\n");
    put("dep/index.ts", "export const value: number = 'wrong';\n");
    result = build();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dep\/index.ts/);
    put("dep/index.ts", "export const value: number = 1;\n");
    put(".next/types/routes.ts", "const route: number = 'wrong'; export {};\n");
    result = build();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /routes.ts/);
    put(".next/types/routes.ts", "export {};\n");
    assert.equal(build().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extra solution discovery and invalid workspace metadata fail closed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-discovery-"));
  const put = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
  try {
    put("solution.json", { files: [] });
    put("package.json", { aistudy: { typecheck: { extraProjects: [{ project: "solution.json", mode: "build" }] } } });
    assert.equal(deriveTypecheckSet(dir)[0].mode, "build");
    mkdirSync(path.join(dir, "apps/web"), { recursive: true });
    put("package.json", { workspaces: ["apps/*"] });
    put("apps/web/package.json", { scripts: { typecheck: "tsc" }, aistudy: { typecheck: { mode: "typo" } } });
    assert.throws(() => deriveTypecheckSet(dir), /invalid typecheck mode/);
    put("apps/web/package.json", { scripts: { typecheck: "tsc" } });
    assert.throws(() => deriveTypecheckSet(dir), /missing typecheck project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
