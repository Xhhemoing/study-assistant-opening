import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const states = new Set(["planned", "active", "blocked", "verified"]);

export function validateTaskGraph(tasks) {
  const errors = [];
  const byId = new Map();
  for (const t of tasks) {
    if (byId.has(t.id)) errors.push(`duplicate task: ${t.id}`);
    byId.set(t.id, t);
    if (!t.id || !t.owner || !t.plan || !Array.isArray(t.dependsOn)) {
      errors.push(`incomplete task: ${t.id}`);
    }
    if (!states.has(t.status)) errors.push(`invalid status: ${t.id}`);
    if (t.status === "verified" && !t.evidence?.length) {
      errors.push(`verified task lacks evidence: ${t.id}`);
    }
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byId.has(dep)) errors.push(`${t.id}: unknown dependency ${dep}`);
      if (["active", "verified"].includes(t.status) && byId.get(dep)?.status !== "verified") {
        errors.push(`${t.id}: dependency ${dep} not verified`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`cycle detected at ${id}`); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return errors;
}

export function validatePlanFiles(root) {
  const dir = path.join(root, "docs/superpowers/plans/opening-release");
  const manifest = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8"));
  const errors = validateTaskGraph(manifest.tasks);
  const master = readFileSync(path.join(root, "docs/superpowers/plans/2026-09-12-opening-release-implementation.md"), "utf8");
  for (const task of manifest.tasks) {
    const file = path.resolve(dir, task.plan);
    if (path.dirname(file) !== dir || !existsSync(file)) {
      errors.push(`missing or invalid plan: ${task.id}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (!new RegExp(`^#{2,3} ${task.id}:`, "m").test(text)) errors.push(`missing task section: ${task.id}`);
    if (!master.includes(`| ${task.id} |`)) errors.push(`missing master row: ${task.id}`);
    if (/\b(TODO|TBD|FIXME)\b/.test(text)) errors.push(`unresolved marker: ${task.plan}`);
    if ((text.match(/^```/gm)?.length ?? 0) % 2 !== 0) errors.push(`unclosed code fence: ${task.plan}`);
    for (const evidence of task.evidence ?? []) {
      const evidencePath = path.resolve(dir, evidence);
      if (!evidencePath.startsWith(root + path.sep) || !existsSync(evidencePath)) {
        errors.push(`missing or invalid evidence: ${task.id} -> ${evidence}`);
      }
    }
  }
  const ready = manifest.tasks.filter(t => t.status === "planned" && t.dependsOn.every(
    id => manifest.tasks.find(p => p.id === id)?.status === "verified",
  )).map(t => t.id);
  return { errors, count: manifest.tasks.length, ready };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = validatePlanFiles(root);
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Plan structure: PASS (${result.count} tasks, acyclic dependencies, plan/evidence files present)`);
    console.log(`Ready tasks: ${result.ready.join(", ")}`);
    console.log("This checks plan integrity, not application correctness or learning effectiveness.");
  }
}
