# B02 Browser/Server Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing production bundle compile without replacing cryptographic hashing with a browser shim.

**Architecture:** Keep the main domain entry browser-safe. Move Node-dependent backup operations to an explicit `@aistudy/domain/native` package export; keep browser-safe constants, errors and type-only exports at the root.

**Tech Stack:** Existing TypeScript, Next.js, Vitest.

## Global Constraints

- Reproduced build failure: `node:crypto -> portability/native/files.ts -> native/index.ts -> domain/index.ts -> practice-player.tsx`.
- Do not alias crypto to false, add a polyfill, change hashing semantics or alter backup file format.
- This task is necessary baseline work, not permission to refactor the full domain package.

## B02: Separate native backup operations

**Owner:** INTEGRATOR. Depends: B01.
**Create:** `packages/domain/src/browser-boundary.test.ts`.
**Modify:** `packages/domain/src/index.ts`, `packages/domain/package.json`, `packages/database/src/repositories/backup-dump.ts`, `packages/database/src/repositories/backup-restore.ts`, `vitest.config.ts`.
**Interfaces:** root keeps types, constants, NativeBackupError; `@aistudy/domain/native` exports buildNativeBackup, planNativeRestore, sha256Hex and existing native helpers.

- [x] Write regression test: root has no buildNativeBackup/planNativeRestore/sha256Hex; native hash of abc is the standard SHA-256 test vector.
- [x] Run `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/browser-boundary.test.ts`; expect root-export assertion failure.
- [x] Replace native barrel re-export with direct safe exports and type-only exports; add package subpath; move the two repository imports; add the more-specific Vitest alias before the root alias.
- [x] Run the regression, native backup tests, database backup-map tests and full typecheck with Git Bash as npm script shell on Windows.
- [x] Run `npm --script-shell="$(cygpath -w "$(command -v bash)")" run build`; record any next failure rather than calling the bundle fixed early.
- [x] Review narrow diff and record scope. Local commit only after relevant checks pass; no production deployment.

**Recorded commit:** `669708e`.

**Commit boundary:** `fix: isolate native backup code from browser bundle`.
