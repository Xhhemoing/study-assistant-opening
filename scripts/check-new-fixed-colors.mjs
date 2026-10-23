#!/usr/bin/env node
/** Plan §0107: reject newly introduced fixed Tailwind palette classes in UI TSX.
 * Local: node scripts/check-new-fixed-colors.mjs [--base <commit>]
 * The comparison includes staged/unstaged changes and untracked UI files.
 * CI supplies the checked-out commit's available first parent through FIXED_COLOR_BASE.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const palettes = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const roles = "text-shadow|text|bg|border(?:-[xytrblse])?|divide(?:-[xy])?|ring(?:-offset)?|fill|stroke|accent|caret|outline|decoration|shadow|from|via|to";
const fixedColor = new RegExp(`(?<![\\w-])(?:${roles})-(?:black|white|(?:${palettes})-(?:50|[1-9]00|950))(?:/(?:[\\d.]+|\\[[^\\]\\s]+\\]))?(?![\\w-])`, "g");

export function isUiSource(file) {
  return /^(?:apps\/[^/]+\/src\/|packages\/ui\/src\/|packages\/jingwei\/src\/react\/)/.test(file)
    && file.endsWith(".tsx") && !/(?:^|\/)(?:tests|__tests__|__fixtures__)(?:\/|$)|\.(?:test|spec)\.tsx$/.test(file);
}

/** Only changed lines count. Existing classes retained on a rewritten line are not additions. */
export function addedFixedColors(diff) {
  const removed = new Map();
  const added = [];
  let line = 0;
  for (const source of diff.split("\n")) {
    const hunk = source.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (source.startsWith("+++") || source.startsWith("---") || !line) continue;
    if (source.startsWith("-")) {
      for (const token of source.slice(1).match(fixedColor) ?? []) removed.set(token, (removed.get(token) ?? 0) + 1);
    } else if (source.startsWith("+")) {
      for (const token of source.slice(1).match(fixedColor) ?? []) added.push({ line, token });
      line++;
    } else if (source.startsWith(" ")) line++;
  }
  return added.filter(({ token }) => {
    const retained = removed.get(token) ?? 0;
    if (!retained) return true;
    removed.set(token, retained - 1);
    return false;
  });
}

export function checkNewFixedColors({ cwd = process.cwd(), base = process.env.FIXED_COLOR_BASE || "HEAD" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  // Resolve explicitly so an unavailable shallow-checkout base fails, rather than skipping the check.
  const commit = git("rev-parse", "--verify", `${base}^{commit}`).trim();
  const snapshots = [[], ["--cached"]];
  const changed = [...new Set(snapshots.flatMap(snapshot => git("diff", ...snapshot, "--name-only", "--no-renames", "-z", commit, "--").split("\0").filter(isUiSource)))];
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(isUiSource);
  const violations = [];
  for (const file of changed) {
    const seen = new Set();
    // Check the staged snapshot too: an unstaged correction must not hide a
    // fixed-color addition which would still be included by a staged commit.
    for (const snapshot of snapshots) {
      const diff = git("diff", ...snapshot, "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", commit, "--", file);
      for (const entry of addedFixedColors(diff)) {
        const key = `${entry.line}:${entry.token}`;
        if (!seen.has(key)) { seen.add(key); violations.push({ file, ...entry, snapshot: snapshot.length ? "index" : "working tree" }); }
      }
    }
  }
  for (const file of untracked) {
    const lines = readFileSync(path.join(cwd, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      for (const token of lines[index].match(fixedColor) ?? []) violations.push({ file, line: index + 1, token, snapshot: "untracked" });
    }
  }
  return { base: commit, files: changed.length + untracked.length, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1])) throw new Error("Usage: node scripts/check-new-fixed-colors.mjs [--base <commit>]");
    const result = checkNewFixedColors({ base: args[1] || process.env.FIXED_COLOR_BASE || "HEAD" });
    for (const { file, line, token, snapshot } of result.violations) console.error(`${file}:${line} (${snapshot}): newly added fixed color ${token}; use a semantic theme token.`);
    if (result.violations.length) process.exitCode = 1;
    else console.log(`Fixed-color additions: passed (${result.files} changed UI files; base ${result.base.slice(0, 12)}).`);
  } catch (error) {
    console.error(`Fixed-color additions: ${error.message}`);
    process.exitCode = 1;
  }
}
