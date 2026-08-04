# Cloud Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package AIstudy as a production Node.js container that can deploy to Render, Railway, Fly.io, or a standard container host while documenting why Cloudflare Pages is not the primary target.

**Architecture:** Build the monorepo in a Node 22 builder image, emit the existing Next.js standalone output, and run only the Web service in the runtime image. Run PostgreSQL migrations as a separate release command before serving traffic. Keep PostgreSQL, Redis, and S3-compatible storage external to the image. The current Worker remains out of the deployment path because it is still an in-memory smoke processor rather than a real queue consumer.

**Tech Stack:** Node.js 22, npm workspaces, Next.js 15 standalone output, Docker, PostgreSQL, Redis, S3-compatible object storage.

## Global Constraints

- Preserve the existing Next.js App Router and server-side API runtime.
- Do not commit `.env`, credentials, generated output, or database data.
- Production must provide all variables required by `packages/config/src/env.ts`.
- Run `npm run db:migrate` once per release against the production `DATABASE_URL` before accepting traffic.
- Use `SESSION_COOKIE_SECURE=true` behind HTTPS.
- Do not deploy the current Worker as a production queue worker yet.

---

### Task 1: Add a production Web container

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Add the multi-stage Docker build**

Use a Node 22 builder to run `npm ci` and `npm run build`, then copy only Next standalone output, static assets, and public assets into a slim Node runtime. Expose port 3000 and honor the platform-provided `PORT` through `next start` compatibility or the standalone server.

- [ ] **Step 2: Exclude local and generated files**

Ignore `.git`, `.next`, `node_modules`, env files, graph output, coverage, test artifacts, and local logs.

- [ ] **Step 3: Verify Dockerfile structure**

Run a shell/Node structural check that asserts the builder installs from the lockfile, builds the Web workspace, copies standalone assets, exposes port 3000, and does not contain credentials.

---

### Task 2: Add release migration and deployment documentation

**Files:**
- Create: `infra/deploy/render.yaml`
- Create: `docs/operations/cloud-deployment.md`
- Modify: `README.md`

- [ ] **Step 1: Define a Render Blueprint**

Declare one Web service using the repository Dockerfile, a health check at `/api/health`, and a pre-deploy migration command. Leave external PostgreSQL, Redis, and object-storage connections as environment variables instead of provisioning paid or vendor-specific services in the repository.

- [ ] **Step 2: Document Cloudflare Pages boundaries**

Explain that the current standalone Node runtime and Node-dependent API routes are not a direct Pages target. Document the recommended free/low-cost combination: a container host for Web, hosted PostgreSQL, hosted Redis, and R2/S3-compatible storage.

- [ ] **Step 3: Document required production variables and first deployment**

Include redacted variable names, migration order, health verification, HTTPS cookie requirements, rollback guidance, and the current Worker limitation.

- [ ] **Step 4: Link the deployment guide from README**

Add a concise deployment entry without changing existing local development instructions.

---

### Task 3: Verify the deployment slice

**Files:**
- Test: `tests/contract/deployment-config.test.ts`

- [ ] **Step 1: Write deployment contract assertions**

Assert that `Dockerfile`, `.dockerignore`, `infra/deploy/render.yaml`, and the deployment guide exist, contain required commands, do not contain secrets, and document the required environment variables.

- [ ] **Step 2: Run the focused contract test**

Run `npx vitest run tests/contract/deployment-config.test.ts` and confirm it passes.

- [ ] **Step 3: Run TypeScript verification**

Run `npx tsc -p apps/web/tsconfig.json --noEmit` and the focused unit/route tests relevant to the current working tree.

- [ ] **Step 4: Report blocked gates honestly**

Do not claim a Docker build, integration suite, browser suite, or cloud deployment succeeded unless Docker, service dependencies, and browser binaries are available.
