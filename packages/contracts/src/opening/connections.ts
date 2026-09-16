import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const connectionKindSchema = z.enum(["imap", "dingtalk"]);
export const connectionStateSchema = z.enum(["disabled", "needs_authorization", "ready", "syncing", "error", "revoked"]);
export const connectionViewSchema = z.object({
  id: uuidSchema, version: z.number().int().nonnegative(), kind: connectionKindSchema,
  label: z.string().min(1).max(180), state: connectionStateSchema,
  allowedScopes: z.array(z.string().min(1).max(200)), lastSuccessAt: isoDateTimeSchema.nullable(),
  errorCode: z.string().min(1).max(120).nullable(),
}).strict();
export const imapSetupInputSchema = z.object({
  label: z.string().min(1).max(180), host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535),
  tlsMode: z.enum(["implicit", "starttls"]), username: z.string().min(1).max(320),
  folders: z.array(z.string().min(1).max(255)).min(1).max(100), since: z.string().datetime(), clientKey: z.string().min(8).max(200),
}).strict();
export const imapCursorSchema = z.object({ folder: z.string().min(1).max(255), uidValidity: z.string().min(1).max(200), lastUid: z.number().int().nonnegative() }).strict();
export const connectionCredentialInputSchema = z.object({ secret: z.string().min(1), clientKey: z.string().min(8).max(200) }).strict();
export type ConnectionKind = z.infer<typeof connectionKindSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export type ImapSetupInput = z.infer<typeof imapSetupInputSchema>;
export type ImapCursor = z.infer<typeof imapCursorSchema>;
