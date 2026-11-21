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
const imapEndpointFields = {
  // A DNS name is required for TLS server-name verification. Requiring an
  // alphabetic final label also excludes numeric and alternate IPv4 literals.
  host: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)
    .refine(host => !host.toLowerCase().endsWith(".localhost")),
  port: z.number().int(),
  tlsMode: z.enum(["implicit", "starttls"]),
};

function usesApprovedImapPort(input: { port: number; tlsMode: "implicit" | "starttls" }): boolean {
  return input.port === (input.tlsMode === "implicit" ? 993 : 143);
}

const imapPortError = { path: ["port"], message: "IMAP requires implicit TLS on port 993 or STARTTLS on port 143" };
export const imapEndpointSchema = z.object(imapEndpointFields).strict().refine(usesApprovedImapPort, imapPortError);

export function isApprovedImapHost(host: string, configuredHosts: string | undefined): boolean {
  return (configuredHosts ?? "").split(",").some(value => value.trim().toLowerCase() === host.toLowerCase());
}

export const imapSetupInputSchema = z.object({
  ...imapEndpointFields,
  label: z.string().min(1).max(180), username: z.string().min(1).max(320),
  folders: z.array(z.string().min(1).max(255)).min(1).max(100), since: z.string().datetime(), clientKey: z.string().min(8).max(200),
}).strict().refine(usesApprovedImapPort, imapPortError);
export const imapCursorSchema = z.object({ folder: z.string().min(1).max(255), uidValidity: z.string().min(1).max(200), lastUid: z.number().int().nonnegative() }).strict();
export const connectionCredentialInputSchema = z.object({ secret: z.string().min(1), clientKey: z.string().min(8).max(200) }).strict();
export type ConnectionKind = z.infer<typeof connectionKindSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type ConnectionView = z.infer<typeof connectionViewSchema>;
export type ImapSetupInput = z.infer<typeof imapSetupInputSchema>;
export type ImapCursor = z.infer<typeof imapCursorSchema>;
