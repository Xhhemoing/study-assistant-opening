import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validatePlanFiles } from "../../scripts/validate-opening-plan.mjs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("docs/superpowers/plans/opening-release/tasks.json"));
const byId = new Map(manifest.tasks.map((task) => [task.id, task]));
const capabilities = {
  CAP01: ["C01", "C02"], // school-hosted email
  CAP02: ["C01", "C03"], // authorized DingTalk
  CAP03: ["V01"], // audio/video understanding, not just storage
  CAP04: ["K01"], // source-backed course knowledge structure
  CAP05: ["K02"], // evidence-driven tutoring and retesting
  CAP06: ["P04", "U04"], // proactive learning/life planning
};

for (const [requirement, ids] of Object.entries(capabilities)) {
  test(`${requirement} has executable tasks and acceptance traceability`, () => {
    const trace = read("docs/superpowers/plans/opening-release/traceability.md");
    const row = trace.split("\n").find((line) => line.startsWith(`| ${requirement} |`));
    assert.ok(row, `missing traceability: ${requirement}`);
    for (const id of ids) {
      assert.ok(byId.has(id), `missing task: ${id}`);
      assert.ok(row.includes(id), `missing mapping: ${requirement} -> ${id}`);
    }
  });
}

test("expanded release gate depends on every requested capability", () => {
  assert.ok(byId.has("Q04"), "missing expanded release gate");
  const ancestors = new Set();
  function visit(id) {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
  }
  visit("Q04");
  for (const id of ["X01", "Q02", ...Object.values(capabilities).flat()]) {
    assert.ok(ancestors.has(id), `Q04 omits ${id}`);
  }
});

test("expanded task dependencies agree across manifest, master and subplans", () => {
  const master = read("docs/superpowers/plans/2026-09-12-opening-release-implementation.md");
  for (const id of ["X01", "C01", "C02", "C03", "V01", "K01", "K02", "P04", "U04", "Q04"]) {
    const task = byId.get(id);
    assert.ok(task, `missing task: ${id}`);
    const plan = read(`docs/superpowers/plans/opening-release/${task.plan}`);
    const section = plan.split(`### ${id}:`)[1]?.split("\n### ")[0];
    assert.ok(section, `missing section: ${id}`);
    const declared = section.match(/\*\*Depends:\*\* ([^\n.]+)\./)?.[1].split(",");
    assert.deepEqual(declared?.sort(), [...task.dependsOn].sort(), `subplan differs: ${id}`);
    const row = master.split("\n").find((line) => line.startsWith(`| ${id} |`));
    assert.ok(row, `missing master row: ${id}`);
    assert.deepEqual(row.split("|")[4].trim().split(",").sort(), [...task.dependsOn].sort(), `master differs: ${id}`);
  }
});

test("expanded plan has valid task sections, dependencies and evidence paths", () => {
  assert.deepEqual(validatePlanFiles(root).errors, []);
});
