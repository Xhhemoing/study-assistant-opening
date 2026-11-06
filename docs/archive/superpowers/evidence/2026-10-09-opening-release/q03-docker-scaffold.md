# Q03 slice — Docker production profile scaffold

**Date:** 2026-10-09 (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** scaffold only — **not verified**, **not deployed**, **no commit**.

## Created

| Path | Role |
|---|---|
| `infra/docker/Dockerfile.opening-web` | Next standalone web image; no Python/Docling |
| `infra/docker/Dockerfile.opening-worker` | Worker + isolated Python/Docling venv; no docker.sock; no AI shell |
| `infra/docker/compose.opening.yml` | Production-oriented profile (loopback binds, required env secrets, volumes, healthchecks, limits, restart) |
| `infra/docker/opening.env.example` | Required vars with `REPLACE_ME` placeholders |

## Constraints encoded

- Distinct from default-password `infra/docker/compose.yml` (public ports + `aistudy`/`minioadmin`).
- Compose fails closed on missing `OPENING_POSTGRES_*`, `OPENING_REDIS_PASSWORD`, `OPENING_S3_*` via `${VAR:?…}`.
- DB/Redis/MinIO/web published on `127.0.0.1` only.
- Named volumes: `opening_pg_data`, `opening_redis_data`, `opening_minio_data`, `opening_hf_home`.
- Healthchecks + `restart: unless-stopped` (except one-shot `minio-init`).
- `deploy.resources` CPU/memory limits on core services.
- Comments forbid Docker socket mounts and AI-facing arbitrary shell.

## Explicitly not done

- Image build / compose up / restore drill / packaging gates.
- Backup/restore CLI or monolith `opening-backup.ts` wrapper (next slices).
- `tasks.json` remains active for Q03 — do not mark verified from scaffold alone.
