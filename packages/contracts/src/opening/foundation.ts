import { z } from "zod";

/** Pinned Docling release for opening ingestion (I02). Formula enrichment defaults OFF. */
export const DOCLING_PINNED_VERSION = "2.126.0" as const;

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime();
export const sha256HexSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/i, "sha256 must be 64 hex chars");

export const scopeSchema = z
  .object({
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
  })
  .strict();

export const apiFailureSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

export type Scope = z.infer<typeof scopeSchema>;
export type ApiFailure = z.infer<typeof apiFailureSchema>;
