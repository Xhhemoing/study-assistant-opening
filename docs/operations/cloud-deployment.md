# Cloud Deployment

AIstudy can be deployed as a Node.js container. The current Web application uses Next.js App Router route handlers, a PostgreSQL driver, Redis connectivity checks, S3-compatible storage, and server-side session cookies. It is therefore not a direct static Cloudflare Pages deployment.

## Recommended Shape

```text
Container Web service
  -> Managed PostgreSQL
  -> Managed Redis
  -> Cloudflare R2 or Amazon S3
```

The Web container is portable across Render, Railway, Fly.io, and ordinary VM/container platforms. `infra/deploy/render.yaml` provides a Render Blueprint as a concrete starting point.

Cloudflare Pages can still be used for a separate static marketing site or a future frontend-only build. Moving the full application to Cloudflare Workers/Pages would require a separate runtime adaptation for the Node-dependent API and database libraries, so it is not the deployment path for the current codebase.

## Production Variables

Set these as server-side secrets or service variables. Do not commit values.

```text
NODE_ENV=production
PUBLIC_BASE_URL=https://your-domain.example
DATABASE_URL=<managed PostgreSQL connection string>
REDIS_URL=<managed Redis connection string>
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=<bucket-name>
S3_ACCESS_KEY_ID=<server-side access key>
S3_SECRET_ACCESS_KEY=<server-side secret key>
S3_FORCE_PATH_STYLE=false
AUTH_SECRET=<random value of at least 32 characters>
SESSION_COOKIE_SECURE=true
SESSION_TTL_SECONDS=604800
AUTH_COOKIE_NAME=aistudy_session
```

`AUTH_SECRET`, `DATABASE_URL`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` must be stored as protected secrets. R2/S3 credentials are used only by server code and must never be exposed as public frontend variables.

## Render Deployment

1. Create the external PostgreSQL, Redis, and R2/S3 resources.
2. Add the variables above to the Render service.
3. Create the service from `infra/deploy/render.yaml`, or select Docker deployment with the repository root as the Docker context.
4. The release command runs `npm run db:migrate` before the new Web instance receives traffic.
5. Confirm `https://your-domain.example/api/health` returns `status: "ok"`.
6. Open the Web URL and verify registration, login, document creation, search, and logout.

The repository Dockerfile uses the existing Next.js `standalone` output and starts `apps/web/server.js` on port 3000. Cloud platforms may provide a `PORT` value; the standalone server reads the runtime port configuration supplied by the platform.

## Free or Low-Cost Services

For personal testing, the following arrangement can remain within free quotas when available:

- Web container: Render or Railway free/trial service, subject to sleep and quota rules
- PostgreSQL: Neon Free or Supabase Free
- Redis: Upstash Redis free quota
- Object storage: Cloudflare R2 free allowance or another S3-compatible free tier
- Domain: provider subdomain such as `onrender.com` or `vercel.app` while testing

Free tiers can suspend services, limit connections, or remove operational guarantees. They are suitable for personal evaluation, not for a production promise or sensitive data without backups.

## Migrations and Rollback

Run migrations only through the canonical runner:

```bash
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

Take a database backup before a production migration. Do not edit or delete an already published migration. If a migration fails, keep the new Web release stopped, inspect the migration registry and database state, then correct the controlled deployment input before retrying.

## Current Scope Limitations

- The Worker is still an in-memory smoke processor. It is not a production BullMQ consumer and is intentionally not part of this Web deployment.
- PostgreSQL, Redis, and S3-compatible storage are required by the current environment contract even when a particular page does not use every dependency.
- A real cloud deployment still requires running integration and browser gates against the selected managed services.
- The existing uncommitted worktree must be reviewed and committed intentionally before deploying from Git.
