import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ROOTS = [
  "apps/web/src/features/opening",
  "apps/web/src/app/api/opening",
];

function filesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = path.join(abs, entry);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(path.relative(ROOT, full)));
      continue;
    }
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
    if (/\.[cm]?[jt]sx?$/.test(entry)) out.push(full);
  }
  return out;
}

it("opening features and routes do not import mock providers or demo data", () => {
  const offenders: string[] = [];
  for (const file of ROOTS.flatMap(filesUnder)) {
    const text = readFileSync(file, "utf8");
    if (text.includes("/lib/data/mock") || text.includes("createMockProvider")) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  expect(offenders).toEqual([]);
});
