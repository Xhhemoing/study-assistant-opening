/**
 * PR-H: generate (--write) or verify (--check) .env.example and
 * infra/docker/opening.env.example from packages/config/src/registry.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV_TEMPLATE_FILES, renderEnvTemplate, type EnvTemplateTarget } from "../packages/config/src/env-template";

const mode = process.argv.includes("--write") ? "write" : "check";
const root = path.resolve(__dirname, "..");
let drift = 0;
for (const target of Object.keys(ENV_TEMPLATE_FILES) as EnvTemplateTarget[]) {
  const file = path.join(root, ENV_TEMPLATE_FILES[target]);
  const expected = renderEnvTemplate(target);
  if (mode === "write") { writeFileSync(file, expected, "utf8"); console.log(`wrote ${ENV_TEMPLATE_FILES[target]}`); continue; }
  let actual = "";
  try { actual = readFileSync(file, "utf8"); } catch { /* missing counts as drift */ }
  if (actual === expected) console.log(`ok ${ENV_TEMPLATE_FILES[target]}`);
  else { drift += 1; console.error(`DRIFT ${ENV_TEMPLATE_FILES[target]}: run npx tsx scripts/env-examples.ts --write`); }
}
process.exit(drift ? 1 : 0);
