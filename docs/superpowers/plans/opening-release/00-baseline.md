# B00 Reproducible Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the isolated, committed baseline without changing dependency versions or integrity hashes.

**Architecture:** Keep the npm workspace lockfile. Correct thirteen inaccessible Tencent mirror tarball URLs and configure registry-host replacement locally to this repository.

**Tech Stack:** Node >=20, npm ci, node:test.

## Global Constraints

- Original `E:/Project/AIstudy` working tree is read-only for this task.
- No dependency upgrades, no production credentials, no global npm config edits.
- First failure: plain npm ci -> ECONNRESET on a Tencent mirror URL. Direct probe: mirror 503, official tarball 200.
- Second experiment: host replacement retained `/npm/` and produced official-source 404. Correct the path, not just the hostname.

## B00: Correct lockfile mirror paths

**Owner:** INTEGRATOR (logical role, not a claim that another agent is running).
**Files:** create `tests/tooling/install-registry.test.mjs`; modify `.npmrc`, `package-lock.json` (13 resolved URLs only).
**Interfaces:** consumes existing lockfile v3; produces reproducible npm ci with identical package versions and integrity hashes.

- [x] Write the failing node:test assertion: `.npmrc` uses official HTTPS registry and `replace-registry-host=always`; no lockfile URL uses `mirrors.tencentyun.com` or HTTP.
- [x] Run `node --test tests/tooling/install-registry.test.mjs`; expect assertion failure before the fix.
- [x] Replace each `http://mirrors.tencentyun.com/npm/<package>/-/<tarball>` with `https://registry.npmjs.org/<package>/-/<tarball>`; add the two local registry settings.
- [x] Run the same test; require pass. Compare every package version and integrity value against the pre-change lockfile snapshot.
- [x] Run `npm ci --fetch-retries=0 --fetch-timeout=20000 --no-audit --no-fund`; record exact output, then rerun isolated unit and contract baselines.
- [x] Review `git diff --check` and the narrow diff before any local commit. Do not commit or claim a green baseline if a required check remains failed.

**Recorded commit:** `fab0ee4`.

**Commit boundary:** `fix: make opening baseline install reproducible`; stage only the listed files and this task evidence after checks pass.
