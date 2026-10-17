import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("worker provisioning preserves rollback state and validates the service identity", {
  skip: process.platform !== "linux" ? "systemd worker provisioning targets Linux" : false,
}, () => {
  execFileSync("python3", ["tests/tooling/provision_worker_test.py", "-v"], { cwd: root, stdio: "pipe" });
});
