import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

function invoke(command, args, cwd, input, env = process.env, timeout = 5 * 60_000) {
  return new Promise(resolve => {
    const child = execFile(command, args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, timedOut: Boolean(error?.killed), stdout, stderr });
    });
    child.stdin?.on("error", () => {
      // The child may exit before consuming the prompt. Its exit is reported above.
    });
    child.stdin?.end(input);
  });
}

async function git(cwd, ...args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  const result = await invoke("git", ["--no-optional-locks", ...args], cwd, undefined, env, 30_000);
  if (result.exitCode !== 0) throw new Error("git " + args[0] + " failed in the assigned worktree");
  return result.stdout;
}

function readablePath(value) {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function snapshot(card) {
  const head = (await git(card.worktree, "rev-parse", "HEAD")).trim();
  if (head !== card.base) throw new Error("The worker changed the assigned base commit.");
  const status = await git(card.worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames");
  const rows = status.split("\0").filter(Boolean);
  const files = rows.map(row => row.slice(3)).sort();
  const allowed = card.allowedPaths.map(readablePath);
  for (const file of files) {
    const candidate = readablePath(file);
    if (!allowed.some(rule => rule.endsWith("/") ? candidate.startsWith(rule) : candidate === rule)) {
      throw new Error("Changed path outside the task card: " + file);
    }
  }
  if (rows.some(row => row[0] !== " " && !row.startsWith("??"))) {
    throw new Error("The worktree contains staged changes.");
  }
  const patch = await git(card.worktree, "diff", "--binary", "--no-ext-diff", "HEAD", "--");
  const untracked = await Promise.all(rows.filter(row => row.startsWith("??")).map(async row => {
    const file = row.slice(3);
    const absolute = path.join(card.worktree, file);
    if (!(await lstat(absolute)).isFile()) throw new Error("The worker created a non-regular file: " + file);
    const bytes = await readFile(absolute);
    return [file, bytes.toString("base64")];
  }));
  const ignored = await git(card.worktree, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z");
  return { files, ignored, contents: JSON.stringify({ patch, untracked }) };
}

async function codexAgent({ cwd, prompt, readOnly }) {
  // Use the local Codex ChatGPT login, without inheriting a conflicting API key.
  const env = { ...process.env };
  delete env.CODEX_API_KEY;
  const result = await invoke("codex", [
    "exec", "--json", "--color", "never", "--sandbox", readOnly ? "read-only" : "workspace-write",
    "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-",
  ], cwd, prompt, env, (readOnly ? 5 : 15) * 60_000);
  let threadId;
  let text;
  let terminal = false;
  let failed = false;
  for (const line of result.stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text;
    if (event.type === "turn.completed") terminal = true;
    if (event.type === "turn.failed") failed = true;
  }
  const exitCode = result.exitCode || (terminal && !failed ? 0 : 1);
  const diagnostic = result.timedOut ? "Codex CLI exceeded the local stage time limit."
    : /invalid_api_key|401 Unauthorized/.test(result.stderr)
    ? "Codex CLI authentication failed."
    : "Codex CLI did not return a successful terminal event.";
  return { exitCode, threadId, text, diagnostic };
}

function localCheck(args, cwd) {
  return invoke(process.execPath, args, cwd);
}

function taskPrompt(card, readOnly) {
  const purpose = readOnly
    ? [
      "Independently review the actual diff and any untracked allowed files against the base and the task.",
      "Read the source needed to check regressions. Report concrete blockers. The coordinator already ran the card checks.",
      'Return only JSON: {"verdict":"approved","summary":"..."} or {"verdict":"changes_requested","summary":"..."}.',
    ]
    : [
      "Implement this task in the assigned local worktree and leave its changes unstaged for the coordinator.",
      "Use focused tests and explain the changes and any remaining gap.",
    ];
  return [
    "AIstudy local development task. Read the relevant AGENTS.md instructions.",
    ...purpose,
    "Local filesystem only. No SSH, deployment, production data, browser automation, Git push or commits.",
    "Run PowerShell commands through pwsh with first-line ErrorActionPreference Stop, UTF-8 console/file handling and immediate native exit checks.",
    "Keep all existing changes. Only write the task's allowed files. The board, other worktrees and repository administration are read-only.",
    "Task card:",
    JSON.stringify({
      id: card.id,
      goal: card.goal,
      owner: card.owner,
      risk: card.risk,
      base: card.base,
      allowedPaths: card.allowedPaths,
      checks: card.checks,
      acceptance: card.acceptance,
      notes: card.notes,
    }, null, 2),
  ].join("\n");
}

function boundedText(value) {
  return typeof value === "string" ? value.trim().slice(0, 2500) : "";
}

export async function runLocalCard(card, _repoRoot, { agent = codexAgent, check = localCheck } = {}) {
  const report = { status: "blocked", base: card.base, changedFiles: [], checks: [] };
  try {
    const initial = await snapshot(card);
    if (initial.files.length) throw new Error("The assigned worktree changed before implementation.");
    const worker = await agent({ cwd: card.worktree, prompt: taskPrompt(card, false), readOnly: false });
    report.worker = { exitCode: worker.exitCode, threadId: worker.threadId, summary: boundedText(worker.text) };
    if (worker.exitCode !== 0) throw new Error(worker.diagnostic ?? "The implementation session failed.");

    const candidate = await snapshot(card);
    if (candidate.ignored !== initial.ignored) throw new Error("The worker changed the set of ignored paths.");
    report.changedFiles = candidate.files;
    if (candidate.files.length === 0) throw new Error("The worker returned without a candidate diff.");

    for (const args of card.checks) {
      const result = await check(args, card.worktree);
      report.checks.push({ args, exitCode: result.exitCode });
      if (result.exitCode !== 0) throw new Error("A required local check failed: node " + args.join(" "));
    }
    await git(card.worktree, "diff", "--check", "HEAD", "--");
    const checked = await snapshot(card);
    if (checked.contents !== candidate.contents || checked.ignored !== candidate.ignored) {
      throw new Error("The candidate changed during checks.");
    }

    const review = await agent({ cwd: card.worktree, prompt: taskPrompt(card, true), readOnly: true });
    report.review = { exitCode: review.exitCode, threadId: review.threadId };
    if (review.exitCode !== 0) throw new Error(review.diagnostic ?? "The independent review session failed.");
    if (!worker.threadId || !review.threadId || review.threadId === worker.threadId) {
      throw new Error("The writer and reviewer must have distinct recorded sessions.");
    }
    let verdict;
    try {
      verdict = JSON.parse(review.text);
    } catch {
      throw new Error("The independent reviewer did not return a verdict.");
    }
    report.review.verdict = verdict?.verdict;
    report.review.summary = boundedText(verdict?.summary);
    const reviewed = await snapshot(card);
    if (reviewed.contents !== candidate.contents || reviewed.ignored !== candidate.ignored) {
      throw new Error("The candidate changed during independent review.");
    }
    if (report.review.verdict !== "approved" || !report.review.summary) {
      throw new Error("The independent reviewer did not approve the local candidate.");
    }
    report.status = "candidate_ready";
  } catch (error) {
    report.error = error.message;
  }
  return report;
}
