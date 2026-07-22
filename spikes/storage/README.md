# Storage spike

**Goal:** Prove S3-compatible presigned PUT/GET URLs can be generated with the AWS SDK (endpoint-configurable for MinIO/R2/S3).

Does not require a live object store: validates URL shape, method constraints, and expiry parameters.

**Test:** `src/presign.test.ts`
