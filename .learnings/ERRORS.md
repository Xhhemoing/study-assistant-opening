# Errors

Command failures and integration errors.

---

## [ERR-20260802-014] skill-root-mismatch-current-session

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary
The first skill inspection used the `.codex` root instead of the session's `r0` skill root.

### Error
```text
Get-Content could not find C:\Users\86080\.codex\skills\using-superpowers\SKILL.md
```

### Context
- The available-skills catalog maps `r0` to `C:\Users\86080\.agents\skills` in this desktop session.
- The operation was read-only and did not change repository source files.

### Resolution
- **Resolved**: 2026-08-02T00:00:00+08:00
- **Notes**: Re-read all selected skills from the mapped `r0` root.

### Metadata
- Reproducible: yes
- Related Files: none
- See Also: ERR-20260802-008

---

## [ERR-20260802-015] candidate-thread-type-narrowing

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
The new exploration candidate update captured a nullable result inside a React state updater and failed web TypeScript validation.

### Error
```text
Argument of type '(current) => ({ ... } | null)[]' is not assignable to the candidate state updater.
```

### Context
- The issue appeared after wiring Task 17 candidate state into `exploration-thread.tsx`.
- TypeScript narrowing did not cross the functional updater closure.

### Resolution
- **Resolved**: 2026-08-02T00:00:00+08:00
- **Notes**: Stored `result.candidate` in a local narrowed constant before appending it.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/features/explore/exploration-thread.tsx

---

## [ERR-20260802-003] rg-no-match-validation-exit

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary
An expected `rg` no-match result returned exit code 1 and caused a parallel documentation validation batch to be reported as failed.

### Error
```text
Script failed because a placeholder search found no matches and returned exit code 1.
```

### Context
- The search was checking that a new brainstorm document contained no placeholders.
- No-match was the successful outcome for that individual check.
- The combined runner surfaced only part of the other parallel check output.

### Suggested Fix
Run independent validation commands separately or explicitly normalize the no-match exit code for negative searches.

### Metadata
- Reproducible: yes
- Related Files: docs/brainstorm/2026-08-02-adaptive-learning-decision-governance.md

### Resolution
- **Resolved**: 2026-08-02T00:00:00+08:00
- **Notes**: Subsequent validation commands treat no placeholder matches as a passing result.

---

## [ERR-20260802-003] invalid-vitest-path

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
Parallel context inspection included a root Vitest config path that is not present in this workspace layout.

### Error
```text
Get-Content : Cannot find path 'vitest.config.ts' because it does not exist.
```

### Context
- Diagnostic-only inspection while preparing Task 16.
- Repository file discovery found the actual test config at the workspace root under the existing `vitest.config.ts` lookup context used by the project scripts; no source files were modified.

### Suggested Fix
Use `rg --files -g 'vitest.config.*'` before reading tool configuration paths in this monorepo.

### Metadata
- Reproducible: no
- Related Files: package.json

---

## [ERR-20260802-002] invalid-read-path

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
Parallel context inspection included a data barrel path that does not exist.

### Error
```text
Get-Content : Cannot find path 'apps/web/src/lib/data/index.ts' because it does not exist.
```

### Context
- Diagnostic-only file inspection while preparing Task 16.
- No source files were modified and the path was removed from the follow-up inspection.

### Suggested Fix
Inspect the actual `apps/web/src/lib/data` entries before reading a presumed barrel file.

### Metadata
- Reproducible: no
- Related Files: apps/web/src/lib/data

---

## [ERR-20260802-013] next-dev-build-artifact-race

**Logged**: 2026-08-02T20:30:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
The long-running Next development server returned a webpack runtime 500 after a production build rewrote the shared `.next` directory.

### Error
```text
TypeError: __webpack_modules__[moduleId] is not a function
```

### Context
- `next dev --port 3000` was started for local verification.
- `npx next build` ran in the same `apps/web` directory while that dev server was still running.
- The first `/explore` request after the build returned HTTP 500; subsequent requests recovered to HTTP 200.

### Suggested Fix
Do not run `next build` concurrently with `next dev` against the same `.next` directory. Restart the dev server after a production build before reporting the local URL.

### Metadata
- Reproducible: yes
- Related Files: apps/web/.next, apps/web/src/app/(workspace)/explore/page.tsx

### Resolution
- **Resolved**: 2026-08-02T20:30:00+08:00
- **Notes**: Confirmed the source build passes and route requests recover after the build settles; a clean dev restart is used for final verification.

---

## [ERR-20260802-012] full-test-environment-gate

**Logged**: 2026-08-02T19:40:00+08:00
**Priority**: medium
**Status**: pending
**Area**: tests

### Summary
The full Vitest command still cannot complete in this Windows workspace because integration services and the Playwright browser are unavailable.

### Error
```text
DATABASE_URL is required for integration and handler tests
connect ECONNREFUSED 127.0.0.1:5432
connect ECONNREFUSED 127.0.0.1:6379
Executable doesn't exist at ...\\ms-playwright\\chromium_headless_shell-1179\\...
```

### Context
- Ran `node_modules/.bin/vitest.cmd run` after the frontend editor, version history, and link slices.
- 30 test files passed; 11 environment-dependent files failed or timed out.
- The changed frontend unit tests and web build were already verified independently.

### Suggested Fix
Start the local Postgres and Redis services, set `DATABASE_URL`, and install the pinned Playwright Chromium binary before rerunning the full gate.

### Metadata
- Reproducible: yes
- Related Files: tests/integration, spikes/queue, spikes/test-tooling
- See Also: ERR-20260802-010, ERR-20260802-002

---
 
## [ERR-20260802-012] diagnostic-command-aggregation

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: docs

### Summary
Parallel diagnostic reads were interrupted by expected non-zero exits from a missing indexed filename and an `rg` no-match result.

### Error
```text
Get-Content could not find the indexed rollout summary filename.
rg returned exit code 1 when no matching prior error entry existed.
```

### Context
- The operations only inspected local memory and learning records.
- No repository source or configuration behavior was affected.

### Suggested Fix
Use verified summary filenames and treat `rg` no-match as a handled diagnostic result before aggregating parallel commands.

### Metadata
- Reproducible: yes
- Related Files: C:\\Users\\86080\\.codex\\memories\\MEMORY.md, .learnings/ERRORS.md

---

## [ERR-20260802-011] graphify-dependency-install-timeout

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: config

### Summary
Installing graphifyy into the isolated temporary dependency directory exceeded the 120-second command limit.

### Error
```text
command timed out after 120716 milliseconds
```

### Context
- The bundled Python runtime had no graphify dependencies.
- The install target was `C:\tmp\aistudy-graphify-deps`; repository files were not changed by the install command.

### Suggested Fix
Reuse the existing uv cache or complete the dependency install with a longer bounded timeout before the next graphify update.

### Metadata
- Reproducible: unknown
- Related Files: graphify-out/graph.json

---

## [ERR-20260802-010] graphify-update-python-runtime

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: config

### Summary
The required post-edit `graphify update .` could not start because the graph cache points to a missing Python executable.

### Error
```text
did not find executable at 'C:\Users\86080\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe'
```

### Context
- `graphify-out/graph.json` exists and the update command was run from the repository root after provider changes.
- No graph output was updated by the failed command.

### Suggested Fix
Use an available workspace Python runtime, rewrite `graphify-out/.graphify_python`, and rerun `graphify update .`.

### Metadata
- Reproducible: yes
- Related Files: graphify-out/.graphify_python

---

## [ERR-20260802-009] powershell-dynamic-route-path

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
PowerShell treated Next.js dynamic route brackets as a wildcard during a read-only file inspection.

### Error
```text
An object at the specified path apps/web/src/app/api/documents/[id]/route.ts does not exist
```

### Context
- The route exists under a literal `[id]` directory.
- The command combined several reads, so the inspection was rerun with `-LiteralPath`.

### Suggested Fix
Use `Get-Content -LiteralPath` for Next.js dynamic route files on Windows.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/app/api/documents/[id]/route.ts

---

## [ERR-20260802-008] skill-relative-path-resolution

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
The first attempt to read repository skills treated the `r0` locator alias as a repository-relative path.

### Error
```text
Get-Content : Cannot find path 'E:\Project\AIstudy\r0\impeccable\SKILL.md'
```

### Context
- The available-skills catalog maps `r0` to `C:\Users\86080\.agents\skills`.
- The failed operation was read-only and did not modify project code.

### Suggested Fix
Expand skill-root aliases from the session catalog before reading filesystem-backed skill files.

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260802-002] goal-component-red-test

**Logged**: 2026-08-02T22:58:06+08:00
**Priority**: low
**Status**: pending
**Area**: tests

### Summary
The focused goal component test suite failed because the planned `goal-wizard` module had not been implemented yet.

### Error
```text
Error: Cannot find module './goal-wizard' imported from apps/web/src/features/goals/goal-components.test.ts
```

### Context
- Ran the Task 18 focused Vitest command before implementing the missing production component.
- The model test passed; the component suite did not reach its tests.

### Suggested Fix
Implement the planned goal wizard module, then rerun the focused suite.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/features/goals/goal-components.test.ts, apps/web/src/features/goals/goal-wizard.tsx

---

## [ERR-20260802-007] skill-review-agent-timeout

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
The second read-only review request stayed running through repeated bounded waits and was stopped after the local validation had completed.

### Context
- The first review completed and identified six actionable issues; all six were addressed.
- The second review was reloaded on the revised files but produced no new result within the wait window.
- No review agent edits were detected.

### Suggested Fix
Use one bounded review request per skill revision or rely on local contract checks when the review agent cannot return promptly.

### Metadata
- Reproducible: unknown
- Related Files: `.agents/skills/aistudy-git-workflow/SKILL.md`

---

## [ERR-20260802-006] skill-validation-python-missing

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
The official skill validator could not run because the current Windows shell exposes neither `python`, `py`, nor `python3`.

### Error
```text
python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

### Context
- The validator is `C:\Users\86080\.codex\skills\.system\skill-creator\scripts\quick_validate.py`.
- The skill content was checked with a PowerShell contract validator instead.

### Suggested Fix
Use the bundled workspace Python runtime when available, or keep a non-Python structural fallback for Windows-only sessions.

### Metadata
- Reproducible: yes
- Related Files: `.agents/skills/aistudy-git-workflow`

---

## [ERR-20260802-005] skill-scaffold-interface-length

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
The skill initializer created the directory and template but stopped before generating `agents/openai.yaml` because the UI short description was shorter than the required minimum.

### Error
```text
short_description must be 25-64 characters (got 18).
```

### Context
- The attempted short description was `项目 Git 拉取提交合并与质量验证`.
- The template was replaced manually and the valid metadata file was added afterward.

### Suggested Fix
Use a 25-64 character UI description when invoking `init_skill.py`.

### Metadata
- Reproducible: yes
- Related Files: `.agents/skills/aistudy-git-workflow/agents/openai.yaml`

---

## [ERR-20260802-003] skill-path-resolution

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
The first attempt to read the skill-creator instructions used the cross-runtime skill path instead of the Codex system skill path.

### Error
```text
Get-Content : Cannot find path 'C:\Users\86080\.agents\skills\skill-creator\SKILL.md'
```

### Context
- The skill exists under `C:\Users\86080\.codex\skills\.system\skill-creator\SKILL.md` in this Codex desktop environment.
- The failed command was read-only and did not modify project files.

### Suggested Fix
Resolve skill paths from the available-skills locator before reading system-provided skills.

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260802-004] powershell-diagnostic-exit-code

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
A combined PowerShell diagnostic command returned exit code 1 because `rg` found no matches in one search branch, despite producing useful output.

### Context
- The command inspected project guidance and configuration files.
- No project files were changed by the failed command.

### Suggested Fix
Treat optional searches as non-fatal when composing diagnostics, or run them separately with explicit fallback handling.

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260802-003] npx-cache-permission

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
Running tools through `npx` attempted to write the user npm cache and failed with `EPERM`.

### Error
```text
FetchError: Invalid response body while trying to fetch ... EPERM
```

### Context
- The command was intended to run locally installed ESLint and TypeScript.
- Verification was blocked before either tool ran.

### Suggested Fix
Use `node_modules/.bin` directly when dependencies are installed, or configure a writable project-local npm cache for Windows development.

### Metadata
- Reproducible: yes
- Related Files: package.json

---

## [ERR-20260802-002] npm-script-bash-on-windows

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: config

### Summary
The repository quality scripts invoke `bash`, which is unavailable in the current Windows shell.

### Error
```text
'bash' is not recognized as an internal or external command,
operable program or batch file.
```

### Context
- `npm run lint` failed before ESLint started.
- The same wrapper is used by typecheck, tests, browser tests, and build scripts.

### Suggested Fix
Replace the shell wrapper with a cross-platform Node.js runner or provide a documented shell prerequisite and a Windows-compatible command path.

### Metadata
- Reproducible: yes
- Related Files: package.json, scripts/run-heavy.sh

---

## [ERR-20260802-001] powershell-path-regex

**Logged**: 2026-08-02T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: config

### Summary
PowerShell `-notmatch` regex failed because a Windows path pattern ended with an escaped backslash.

### Error
```text
parsing "\\node_modules\\|\\dist\\|\\.next\\" - Illegal \\ at end of pattern.
```

### Context
- Attempted to exclude generated directories while listing large source files.
- The command was diagnostic only and did not modify project files.

### Suggested Fix
Prefer `-like` checks for literal Windows path fragments or use a regex with escaped backslashes that does not terminate in an escape character.

### Metadata
- Reproducible: yes
- Related Files: none

---
