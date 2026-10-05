import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!["build", "start"].includes(command)) {
  throw new Error("Usage: node scripts/web-preview.mjs build|start [Next.js options]");
}
// Local overrides keep the preview on the user's existing services, not E2E seeds.
let env = {};
for (const name of [".env", ".env.preview"]) {
  const file = path.join(root, name);
  if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file, "utf8")));
}
env = { ...env, ...process.env, NODE_ENV: "production", AISTUDY_WEB_PREVIEW: "1" };
if (env.OPENING_E2E === "1") throw new Error("Preview must not use the E2E environment");
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), command, ...args], {
  cwd: path.join(root, "apps/web"), env, stdio: "inherit", windowsHide: true,
});
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
