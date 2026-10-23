import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { addedFixedColors, checkNewFixedColors, isUiSource } from "./check-new-fixed-colors.mjs";

const hunk = (...lines) => `@@ -1,2 +1,2 @@\n${lines.join("\n")}\n`;
test("rejects new blue classes including variants and opacity", () => {
  assert.deepEqual(addedFixedColors(hunk('+<p className="hover:text-blue-600 bg-blue-50/50 accent-blue-700" />')).map(row => row.token), ["text-blue-600", "bg-blue-50/50", "accent-blue-700"]);
});
test("does not reject untouched old lines or existing colors retained on a rewritten line", () => {
  assert.deepEqual(addedFixedColors(hunk(' <p className="text-blue-600" />', '-<p className="bg-white">Old</p>', '+<p className="bg-white">New</p>')), []);
});
test("allows semantic theme/object classes and deletion of old palette classes", () => {
  assert.deepEqual(addedFixedColors(hunk('-<p className="text-blue-600 bg-white" />', '+<p className="text-text bg-surface border-line ring-focus-ring fill-obj-1 stroke-obj-4 accent-accent" />')), []);
});
test("does not let one removed occurrence hide multiple new uses", () => {
  assert.deepEqual(addedFixedColors(hunk('-<p className="text-blue-600" />', '+<p className="text-blue-600"><span className="text-blue-600" /></p>')), [{ line: 1, token: "text-blue-600" }]);
});
test("limits the check to app and UI TSX excluding test fixtures", () => {
  for (const file of ["apps/web/src/app/page.tsx", "packages/ui/src/button.tsx", "packages/jingwei/src/react/view.tsx"]) assert.equal(isUiSource(file), true, file);
  for (const file of ["apps/web/src/page.test.tsx", "apps/web/src/page.spec.tsx", "apps/web/src/__fixtures__/view.tsx", "tests/e2e/view.tsx", "packages/domain/src/view.tsx", "apps/web/src/model.ts"]) assert.equal(isUiSource(file), false, file);
});
test("compares a real commit with committed/staged/unstaged and untracked UI changes", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "study-fixed-colors-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const shallow = mkdtempSync(path.join(os.tmpdir(), "study-fixed-colors-shallow-"));
  const write = (file, contents) => { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), contents); };
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    write("apps/web/src/old.tsx", '<p className="text-blue-600">old</p>\n');
    git("add", "."); git("commit", "-qm", "fixture base");
    const base = git("rev-parse", "HEAD");
    write("apps/web/src/committed.tsx", '<p className="bg-red-100" />\n');
    git("add", "."); git("commit", "-qm", "fixture change");
    write("apps/web/src/staged.tsx", '<p className="ring-blue-600" />\n'); git("add", ".");
    write("apps/web/src/staged.tsx", '<p className="ring-focus-ring" />\n');
    write("apps/web/src/old.tsx", '<p className="text-blue-600">same class, changed text</p>\n<p className="text-zinc-900" />\n');
    write("apps/web/src/untracked.tsx", '<p className="fill-green-500" />\n');
    write("apps/web/src/ignored.test.tsx", '<p className="bg-white" />\n');
    assert.deepEqual(checkNewFixedColors({ cwd, base }).violations.map(row => row.token).sort(), ["bg-red-100", "fill-green-500", "ring-blue-600", "text-zinc-900"]);
    execFileSync("git", ["clone", "--quiet", "--depth=2", pathToFileURL(cwd).href, shallow], { stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: shallow, encoding: "utf8" }).trim(), "true");
    assert.deepEqual(checkNewFixedColors({ cwd: shallow, base: "HEAD^1" }).violations.map(row => row.token), ["bg-red-100"]);
    assert.deepEqual(checkNewFixedColors({ cwd }).violations.map(row => row.token).sort(), ["fill-green-500", "ring-blue-600", "text-zinc-900"]);
    assert.throws(() => checkNewFixedColors({ cwd, base: "missing-ref" }));
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(shallow, { recursive: true, force: true }); }
});
