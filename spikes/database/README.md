# Database spike

**Goal:** Prove PostgreSQL + Drizzle can migrate a table, commit a transaction with JSONB, and isolate tests via rollback.

**Env:**
```bash
export DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_spike
```

**Test:** `src/jsonb-transaction.test.ts`
