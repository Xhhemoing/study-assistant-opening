import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { ImapFlow } from "imapflow";
import { isPublicProviderAddress } from "@aistudy/ai/provider-network";
import { imapEndpointSchema, isApprovedImapHost } from "@aistudy/contracts";
import {
  attachImapClientErrorGuard,
  installImapCommandGuard,
  MAX_IMAP_CONTROL_COMMAND_BYTES,
  MAX_IMAP_FETCH_COMMAND_BYTES,
  MAX_IMAP_LINE_BYTES,
  MAX_IMAP_LITERAL_BYTES,
  MAX_IMAP_PROBE_COMMAND_BYTES,
  MAX_IMAP_RESPONSE_BYTES,
  type ImapCommandGuardLimits,
} from "./imap-command-guard";

export {
  installImapCommandGuard,
  MAX_IMAP_CONTROL_COMMAND_BYTES,
  MAX_IMAP_FETCH_COMMAND_BYTES,
  MAX_IMAP_LINE_BYTES,
  MAX_IMAP_LITERAL_BYTES,
  MAX_IMAP_PROBE_COMMAND_BYTES,
  MAX_IMAP_RESPONSE_BYTES,
  type ImapCommandGuardLimits,
};

export async function createApprovedImapClient(
  endpoint: { host: string; port: number; tlsMode: string },
  auth: { user: string; pass: string },
  resolve: (host: string) => Promise<LookupAddress[]> = host => lookup(host, { all: true }),
): Promise<ImapFlow> {
  const parsed = imapEndpointSchema.safeParse(endpoint);
  if (!parsed.success || !isApprovedImapHost(parsed.data.host, process.env.OPENING_IMAP_ALLOWED_HOSTS)) {
    throw new Error("IMAP host is not authorized");
  }
  const { host, port, tlsMode } = parsed.data;
  const addresses = await resolve(host);
  const address = addresses.find(candidate => candidate.family === 4) ?? addresses[0];
  if (!address || addresses.some(candidate => isIP(candidate.address) !== candidate.family || !isPublicProviderAddress(candidate.address))) {
    throw new Error("IMAP host is not authorized");
  }
  // ImapFlow passes this literal directly to net.connect / tls.connect. The
  // TLS name is independent and survives the STARTTLS upgrade on that socket.
  const client = new ImapFlow({
    host: address.address,
    port,
    servername: host,
    secure: tlsMode === "implicit",
    doSTARTTLS: tlsMode === "starttls",
    tls: { rejectUnauthorized: true },
    auth,
    maxLineLength: MAX_IMAP_LINE_BYTES,
    maxLiteralSize: MAX_IMAP_LITERAL_BYTES,
    maxResponseSize: MAX_IMAP_RESPONSE_BYTES,
    logger: false,
  });
  return installImapCommandGuard(attachImapClientErrorGuard(client));
}
