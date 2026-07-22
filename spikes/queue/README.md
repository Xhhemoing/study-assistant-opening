# Queue spike

**Goal:** Prove BullMQ can process a job and that the same jobId is not executed twice (idempotent enqueue).

**Env:**
```bash
export REDIS_URL=redis://127.0.0.1:6379
```

**Test:** `src/idempotency.test.ts`
