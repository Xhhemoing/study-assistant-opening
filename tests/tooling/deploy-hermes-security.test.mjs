import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const failed of [true, false]) {
  test(`deployment SSH ${failed ? "fails closed" : "pins host keys"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "opening-ssh-"));
    try {
      await mkdir(join(dir, ".aistudy-deploy"));
      await writeFile(join(dir, ".aistudy-deploy/hermes.secret"), "DO-NOT-READ");
      await writeFile(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\n' "$*" >> "$SSH_LOG"\nexit ${failed ? 255 : 0}\n`, { mode: 0o755 });
      await writeFile(join(dir, "python3"), '#!/bin/sh\necho password-fallback >> "$SSH_LOG"\nexit 99\n', { mode: 0o755 });
      const log = join(dir, "ssh.log");
      const result = spawnSync("bash", [resolve("infra/deploy/deploy-hermes.sh"), "status"], {
        encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, SSH_LOG: log },
      });
      assert.equal(result.status, failed ? 1 : 0);
      const calls = await readFile(log, "utf8");
      assert.match(calls, /BatchMode=yes/);
      assert.match(calls, /StrictHostKeyChecking=yes/);
      assert.doesNotMatch(calls, /password-fallback/);
      if (failed) assert.match(result.stderr, /停止部署/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
