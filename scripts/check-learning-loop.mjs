#!/usr/bin/env node
/** Targeted, non-browser validation. Database checks only use the isolated test wrapper. */
import { spawnSync } from "node:child_process";
const focused = [
  "packages/ai/src/opening/model-teaching.test.ts", "packages/ai/src/opening/planning-agent.test.ts",
  "packages/domain/src/opening/onboarding.test.ts", "packages/domain/src/opening/guidance-blocks.test.ts",
  "apps/worker/src/runtime/compile-teaching-unit-wiring.test.ts", "apps/worker/src/jobs/compile-teaching-unit.test.ts",
  "apps/web/src/features/opening/teaching/today-activity.test.ts", "apps/web/src/features/opening/health/liveness.test.ts",
  "apps/web/src/features/opening/assistant/chat-suggestions-model.test.ts", "apps/web/src/features/opening/planning/plan-service.test.ts",
  "apps/worker/src/runtime/budgeted-call.test.ts", "packages/domain/src/opening/day-planner.test.ts",
];
function run(args) {
  console.log(`\n[learning-loop] node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const pkg of ["packages/contracts", "packages/domain", "packages/database", "packages/ai", "apps/web", "apps/worker"])
  run(["node_modules/typescript/bin/tsc", "-p", `${pkg}/tsconfig.json`, "--noEmit"]);
run(["scripts/check-server-boundary.mjs"]);
run(["node_modules/vitest/vitest.mjs", "run", "--project", "unit", ...focused]);
run(["--test", "tests/tooling/deploy-hermes-security.test.mjs"]);
if (process.argv.includes("--database")) {
  run(["scripts/opening-test-db.mjs", "--", process.execPath, "node_modules/vitest/vitest.mjs", "run", "--project", "integration", "tests/integration/opening-learning-loop-hardening.test.ts"]);
  run(["scripts/opening-test-db.mjs", "--", process.execPath, "node_modules/vitest/vitest.mjs", "run", "--project", "handler", "tests/integration/handler/opening-first-login.test.ts", "tests/integration/handler/opening-plans.test.ts"]);
}
