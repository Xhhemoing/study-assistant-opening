# Continuous Integration

## Purpose

Every pull request, every push to `main` or `feat/opening-release`, and every
manual `workflow_dispatch` run must pass platform quality gates before merge or
release sign-off. CI uses isolated service containers and never requires
production secrets. Release evidence must cite the GitHub Actions `quality`
job URL and result for the exact commit SHA being released. Record that pair
in the Q03 readiness checklist at
`docs/superpowers/plans/opening-release/08-delivery.md` (section "Q03:
Production image, backup recovery and operational supervision"); do not open a
separate evidence file for the citation itself. A green run on an older SHA, a
green run on `main` alone, or a local contract check does not cover the active
development branch.

## Workflow

File: `.github/workflows/ci.yml`

Triggers:

- `pull_request`
- `push` to `main` or `feat/opening-release`
- `workflow_dispatch` (manual)

## Gates

| Step | Command | Notes |
|---|---|---|
| Install | `npm ci` | Uses lockfile; cache via setup-node |
| Lint | `npm run lint` | ESLint flat config |
| Typecheck | `npm run typecheck` | packages + web + worker |
| Plan/tooling | `node scripts/validate-opening-plan.mjs` and `node --test tests/tooling/*.test.mjs` | Includes migration reservation conflicts |
| Unit/contract | `npm test -- --project unit --project contract` | Only these named projects |
| Technology spikes | `npm test -- --project '@aistudy/spike-*'` | Spike projects run separately; integration/handler suites are not repeated |
| Integration | `npm run test:integration` | DB/Redis/storage probes |
| Route handlers | `npm run test:handler` | HTTP handler behavior against isolated services |
| Browser E2E | `npm run test:browser` | Real production web server and Playwright Chromium |
| Build | `npm run build` | worker typecheck + Next production build |

## Service containers

| Service | Image | Host port |
|---|---|---:|
| PostgreSQL | `postgres:16-alpine` | 5432 |
| PostgreSQL (E2E) | `postgres:16-alpine` | 5433 |
| Redis | `redis:7-alpine` | 6379 |
| MinIO | `bitnamilegacy/minio:2025.4.22-debian-12-r2` | 9000 |

MinIO image note (2026-09-21): the workflow previously referenced
`bitnami/minio:2025.4.22`, but Bitnami moved pre-2025-08 images to the
`bitnamilegacy` namespace (the `bitnami/minio` repository now has no pullable
tags), and `minio/minio` left Docker Hub entirely. Re-checked 2026-09-22 via
the Docker Hub API: `bitnami/minio` has zero pullable tags (the old tag is
HTTP 404), while `bitnamilegacy/minio:2025.4.22-debian-12-r2` is active for
linux/amd64 and linux/arm64. Its image config starts through
`/opt/bitnami/scripts/minio/entrypoint.sh` and
`/opt/bitnami/scripts/minio/run.sh`, so a GitHub Actions service container can
use the image without overriding CMD. Re-verify pullability whenever CI images
change. Local Compose pins the same MinIO release as
`quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z`; its manifest v2 was present
on 2026-09-22 (digest `sha256:3f97c5651cb6662b880c787a232b6b34fec8d8922e08d6617b25d241a21164bb`).
Registry manifest existence is not a pulled container or a passing health check.

CI and Compose use the second PostgreSQL service at port 5433 for browser E2E
isolation. Without Compose, Playwright defaults to the local `aistudy_e2e`
database on port 5432. The reset script rejects every database name that does
not end in `_e2e`.

CI environment variables match `.env.example` defaults for local fixtures only.
They are not production credentials.

## Local verification

### Daily development

Run the closest relevant test and the owning package's typecheck. For example,
for web editor draft changes (replace these targets for other modules):

```pwsh
$ErrorActionPreference = 'Stop'
npx vitest run --project unit apps/web/src/features/editor/local-draft.test.ts
npm run typecheck -w @aistudy/web
```

Run lint on changed files when relevant. Documentation-only edits need content
and diff review, not the full suite or build. Do not repeat passing checks
without a new change, failure, or unresolved concern. Unit checks require no
service containers. Select the integration or handler project and relevant
file only when the changed behavior needs those services.

Use `npm run verify:ci` only for CI workflow/heavy-runner changes or CI debugging;
it checks structure contracts and does not replace execution. Ordinary
implementation, commits, and PR preparation do not require a duplicate full
local run. Merge and release still depend on the existing remote CI gates.
Browser acceptance belongs to the user; agents do not run or delegate browser
checks without explicit authorization. Unperformed browser acceptance does not
block further development and must not be reported as passed.

### Full local checks, only when explicitly requested

Prerequisites:

- Node.js 20 or newer and dependencies installed from the lockfile.
- Docker with isolated test PostgreSQL, Redis, and MinIO running via
  `npm run compose:up`; integration/handler tests require `OPENING_TEST_DB=1` and
  the explicit loopback `aistudy_opening_test` URL described below.
- Preserve an existing `.env`; copy `.env.example` only when it is absent.

Run the non-browser checks serially, selecting each test project once:

```pwsh
$ErrorActionPreference = 'Stop'
npm run lint
npm run typecheck
npm test -- --project unit --project contract --project notion-pipeline
npm test -- --project '@aistudy/spike-*'
npm run test:integration
npm run test:handler
npm run build
```

Local browser E2E is performed by the user with `npm run test:browser` and needs
Playwright Chromium plus an isolated E2E database whose name ends in `_e2e`.
The existing CI browser step remains required. Neither a scoped check nor a
full local run replaces the remote CI result for the current commit.

`run-heavy.sh` uses `flock`, `nice`, `ionice`, and `taskset` only when each tool
is available. On Windows Git Bash or minimal containers, unavailable host
scheduling controls produce one warning and the requested command still runs;
its exit code is preserved. This fallback removes a portability blocker but
does not provide cross-process serialization.

### Authoritative merge gate

The GitHub Actions `quality` job is authoritative because it installs from the
lockfile, starts isolated services, installs Chromium, and executes every gate
from a clean checkout. A dirty local working tree, `npm run verify:ci`, or a
passing unit-only run is not release evidence. An actual GitHub Actions run
cannot be forged locally: this repository has no `act` runner, no Docker CLI,
and no workflow that fabricates check-run URLs or conclusions. Until the
changed workflow is pushed and GitHub records the `quality` job for that exact
SHA, the remote CI gate is not done.

## Failure policy

- PR checks are required before merge.
- Failing logs must not print secrets (env contract + health responses already
  strip credentials).
- Cache must not hide missing dependencies: always `npm ci` from lockfile.

## Opening release evidence index

Machine index for the opening-release candidate tip (RP7). Cite the tip SHA plus
the quality Actions URL; do not treat index presence as packaging verified or
prod cutover.

- JSON: [`docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json`](../superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json)
- Companion MD: [`docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.md`](../superpowers/evidence/2026-10-10-opening-release/release-evidence-index.md)

Rows whose commit SHA differs from the index tip are marked `stale` and need
re-run on tip. Q03 ledger status is independent of this index.

## Opening parser and isolated test bootstrap

Handler and integration projects validate `OPENING_TEST_DB=1` and the explicit
loopback `aistudy_opening_test` URL, then await the existing migration runner in
`globalSetup`. A single test file receives the same schema initialization as the
full suite. Keep these projects serial while fixtures truncate shared tables.

Parser environment setup and supported text extraction are documented in
[`services/parser/README.md`](../../services/parser/README.md). CI must prepare the
pinned Python dependencies and required model resources before running real
parser tests. Runtime document conversion remains offline; preparing the model
cache is a separate setup operation.

The [2026-09-27 execution record](../superpowers/evidence/2026-09-27-opening-hardening/verification-entry.md)
contains the observed failure, minimal changes, local verification and outstanding
checks for OP-01–OP-03 (B02/F03/Q01/RP5/Q03). It is not a replacement for the
merged-commit GitHub Actions result or the original task ledger.
