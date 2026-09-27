import { spawn } from "node:child_process";
import path from "node:path";
import { buildOpeningE2eEnvironment, projectRoot } from "./environment.mjs";
import { prepareOpeningE2e } from "./prepare.mjs";
import { startOpeningProviderFixture } from "../../tests/support/opening-provider.mjs";

const env = buildOpeningE2eEnvironment();
const children = new Set();
let fixture;
let stopping = false;
function launch(args, cwd = projectRoot) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", windowsHide: true });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function run(args, cwd) {
  const child = launch(args, cwd);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Acceptance command exited ${code}`)));
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  if (fixture) await new Promise((resolve) => fixture.close(resolve));
}
process.on("SIGINT", () => { void stop().then(() => process.exit()); });
process.on("SIGTERM", () => { void stop().then(() => process.exit()); });
async function main() {
  await prepareOpeningE2e(env);
  await run(["--import", "tsx", "scripts/db-reset-e2e.ts"]);
  await run([path.join(projectRoot, "node_modules/next/dist/bin/next"), "build"], path.join(projectRoot, "apps/web"));
  fixture = await startOpeningProviderFixture();
  const worker = launch(["--import", "tsx", "apps/worker/src/index.ts"]);
  const web = launch([path.join(projectRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3100"], path.join(projectRoot, "apps/web"));
  for (const child of [worker, web]) {
    child.once("exit", (code) => {
      if (!stopping) { console.error(`Acceptance service stopped unexpectedly (${code})`); void stop().then(() => process.exit(1)); }
    });
  }
}
main().catch(async (error) => { console.error(error.message); await stop(); process.exitCode = 1; });
