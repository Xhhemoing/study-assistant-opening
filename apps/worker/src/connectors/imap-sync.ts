import type { ImapCursor } from "@aistudy/contracts";
import type {
  createOpeningImportsRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, OpeningScope,
} from "@aistudy/database";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { publishConnectorSource, type ConnectorSourceStorage } from "./publish-source";

export const IMAP_BATCH_SIZE = 100;
export const MAX_MAIL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type ImapClient = Pick<
  ImapFlow,
  "list" | "mailboxOpen" | "fetch" | "fetchOne" | "logout"
>;
export type OpeningImports = ReturnType<typeof createOpeningImportsRepository>;
export type OpeningPrivacy = ReturnType<typeof createOpeningPrivacyRepository>;
export type OpeningSources = ReturnType<typeof createOpeningSourceRepository>;

export function nextImapCursor(previous: ImapCursor, uid: number): ImapCursor {
  return { ...previous, lastUid: Math.max(previous.lastUid, uid) };
}

function safeFilename(name: string | undefined): string {
  return (name ?? "attachment")
    .split(/[\\\\/]/)
    .filter(Boolean)
    .at(-1) ?? "attachment";
}

export function mailToImportInput(input: {
  mail: {
    subject?: string | false;
    text?: string | false;
    html?: unknown;
    attachments?: {
      filename?: string;
      contentType?: string;
      content: Buffer | Uint8Array;
    }[];
  };
}) {
  const attachments = (input.mail.attachments ?? []).map((item) => {
    const bytes = new Uint8Array(item.content);
    return {
      filename: safeFilename(item.filename).slice(0, 180),
      contentType: item.contentType ?? "application/octet-stream",
      bytes,
      size: bytes.byteLength,
    };
  });
  const total = attachments.reduce((sum, item) => sum + item.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("mail attachment total exceeds limit");
  }
  if (attachments.some((item) => item.size > MAX_ATTACHMENT_BYTES)) {
    throw new Error("mail attachment exceeds limit");
  }
  return {
    subject: (input.mail.subject || "(no subject)").slice(0, 200),
    bodyText: (input.mail.text || "").slice(0, 50_000),
    attachments,
  };
}

export type ImapSyncDeps = {
  scope: OpeningScope;
  connectionId: string;
  connectionVersion: number;
  folder: string;
  cursor: ImapCursor | null;
  since: Date;
  client: ImapClient;
  imports: OpeningImports;
  storage: ConnectorSourceStorage;
};

/** Bounded read-only IMAP adapter. Cursor advances only after commit succeeds. */
export async function syncMailbox(deps: ImapSyncDeps): Promise<{
  imported: number;
  skipped: number;
  cursor: ImapCursor;
}> {
  const opened = await deps.client.mailboxOpen(deps.folder, { readOnly: true });
  if (!opened) throw new Error(`folder is unavailable: ${deps.folder}`);
  const uidValidity = String(opened.uidValidity);
  let expectedCursor = deps.cursor;
  let cursor = expectedCursor?.uidValidity === uidValidity
    ? expectedCursor : { folder: deps.folder, uidValidity, lastUid: 0 };

  // Keep only the lowest batch-size distinct UIDs while the discovery stream
  // is consumed. A mailbox can contain millions of eligible messages, so do
  // not retain and sort the entire discovery result in memory.
  const eligibleUids = new Set<number>();
  const stream = deps.client.fetch(
    { uid: `${cursor.lastUid + 1}:*` },
    { uid: true, internalDate: true },
  );
  for await (const message of stream) {
    if (!Number.isSafeInteger(message.uid) || message.uid <= cursor.lastUid
      || (message.internalDate && message.internalDate < deps.since)) continue;
    if (eligibleUids.has(message.uid)) continue;
    if (eligibleUids.size === IMAP_BATCH_SIZE) {
      let highest = -1;
      for (const uid of eligibleUids) highest = Math.max(highest, uid);
      if (message.uid >= highest) continue;
      eligibleUids.delete(highest);
    }
    eligibleUids.add(message.uid);
  }
  // The server can return UIDs in any order. Sorting the bounded set keeps
  // publication and cursor advancement ascending without an unbounded array.
  const uids = [...eligibleUids].sort((a, b) => a - b).slice(0, IMAP_BATCH_SIZE);

  let imported = 0;
  let skipped = 0;
  for (const uid of uids) {
    const identity = {
      connectionId: deps.connectionId,
      container: deps.folder,
      generation: cursor.uidValidity,
      remoteId: String(uid),
    };
    const fetched = await deps.client.fetchOne(
      String(uid),
      { source: true },
      { uid: true },
    );
    if (fetched === false) {
      // The message was expunged after discovery.
      skipped += 1;
      continue;
    }
    if (!fetched?.source || fetched.uid !== uid) throw new Error("IMAP body response did not match the requested UID");
    if (fetched.source.byteLength > MAX_MAIL_BYTES) throw new Error("mail exceeds limit");
    const parsed = await simpleParser(fetched.source, {
      skipImageLinks: true,
      skipHtmlToText: true,
    });
    const prepared = mailToImportInput({ mail: parsed });
    const next = nextImapCursor(cursor, uid);
    const receipt = await publishConnectorSource(deps.imports, deps.storage, deps.scope, {
      connectionVersion: deps.connectionVersion,
      identity,
      name: `${prepared.subject}.eml`,
      mime: "message/rfc822",
      bytes: fetched.source,
      cursor: { expected: expectedCursor, next },
    });
    expectedCursor = cursor = next;
    if (receipt.duplicate) skipped += 1;
    else imported += 1;
  }

  if (expectedCursor?.uidValidity !== uidValidity) {
    await deps.imports.advanceImapCursor(deps.scope, {
      connectionId: deps.connectionId, connectionVersion: deps.connectionVersion,
      cursor: { expected: expectedCursor, next: cursor },
    });
  }

  await deps.client.logout();
  return { imported, skipped, cursor };
}
