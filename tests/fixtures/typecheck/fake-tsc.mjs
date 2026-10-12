// Fake tsc for orchestrator tests: records concurrency via a counter dir.
import { mkdirSync, rmSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
const name = process.argv.at(-1).replace(/[^\w.-]/g, "_");
const dir = process.env.FAKE_TSC_DIR;
const mark = path.join(dir, "active", `${name}.${process.pid}`);
mkdirSync(path.dirname(mark), { recursive: true });
mkdirSync(mark);
const n = readdirSync(path.join(dir, "active")).length;
appendFileSync(path.join(dir, "peak.log"), `${n}\n`);
appendFileSync(path.join(dir, "pids.log"), `${process.pid}\n`);
const fail = process.env.FAKE_TSC_FAIL === name;
setTimeout(() => { rmSync(mark, { recursive: true, force: true }); process.exit(fail ? 7 : 0); },
  Number(process.env.FAKE_TSC_MS ?? 300));
