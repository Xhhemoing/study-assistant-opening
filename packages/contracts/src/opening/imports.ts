import { z } from "zod";
import { uuidSchema, sha256HexSchema } from "./foundation";

export const importIdentitySchema = z.object({ connectionId: uuidSchema, container: z.string().min(1).max(255), generation: z.string().min(1).max(200), remoteId: z.string().min(1).max(500) }).strict();
export const importReceiptSchema = z.object({ id: uuidSchema, sourceIds: z.array(uuidSchema), duplicate: z.boolean(), connectionVersion: z.number().int().nonnegative() }).strict();
export const emailImportInputSchema = z.object({ name: z.string().min(1).max(180), mime: z.literal("message/rfc822"), bytes: z.number().int().positive().max(25 * 1024 * 1024), sha256: sha256HexSchema }).strict();
export type ImportIdentity = z.infer<typeof importIdentitySchema>;
export type ImportReceipt = z.infer<typeof importReceiptSchema>;
export type EmailImportInput = z.infer<typeof emailImportInputSchema>;
