# Local infrastructure (Docker Compose)

Copy `.env.example` to `.env` at the repository root.

## Services

| Service | Host port | Purpose |
|---|---:|---|
| PostgreSQL 16 | 5432 | System of record |
| Redis 7 | 6379 | BullMQ / cache |
| MinIO | 9000 (API), 9001 (console) | S3-compatible object storage |

## Commands

From repository root:

```bash
cp .env.example .env
npm run compose:up
# wait for healthy services
npm run test:integration -- health
npm run compose:down
```

Data volumes are named and retained across restarts:

- `aistudy_pg_data`
- `aistudy_redis_data`
- `aistudy_minio_data`

## Without Docker

If Compose is unavailable, point `DATABASE_URL` / `REDIS_URL` at local
PostgreSQL and Redis, and provide any S3-compatible endpoint for storage checks.
