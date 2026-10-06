import { createHash } from "node:crypto";
import type { ImapCursor } from "@aistudy/contracts";
import { uploadInputSchema } from "@aistudy/contracts";
import type {
  createOpeningImportsRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
  OpeningScope,
} from "@aistudy/database";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export const IMAP_BATCH_SIZE = 100;
export const MAX_MAIL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type ImapClient = Pick<
  ImapFlow,
  "list" | "mailboxOpen" | "fetch" | "fetchOne" | "logout"
>;
export type OpeningSources = ReturnType<typeof createOpeningSourceRepository>;
export type OpeningImports = ReturnType<typeof createOpeningImportsRepository>;
export type OpeningPrivacy = ReturnType<typeof createOpeningPrivacyRepository>;
export type OpeningStorageUpload = (input: {
  key: string;
  bytes: Uint8Array;
  mime: string;
}) => Promise<void>;

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
  cursor: ImapCursor;
  since: Date;
  client: ImapClient;
  imports: OpeningImports;
  sources: OpeningSources;
  privacy: OpeningPrivacy;
  upload: OpeningStorageUpload;
};

/** Bounded read-only IMAP adapter. Cursor advances only after commit succeeds. */
export async function syncMailbox(deps: ImapSyncDeps): Promise<{
  imported: number;
  skipped: number;
  cursor: ImapCursor;
}> {
  const opened = await deps.client.mailboxOpen(deps.folder, { readOnly: true });
  if (!opened) throw new Error(`folder is unavailable: ${deps.folder}`);
  let cursor = deps.cursor.folder === deps.folder
    ? deps.cursor
    : { folder: deps.folder, uidValidity: String(opened.uidValidity), lastUid: 0 };
  if (cursor.uidValidity !== String(opened.uidValidity)) {
    cursor = { folder: deps.folder, uidValidity: String(opened.uidValidity), lastUid: 0 };
  }

  const uids: number[] = [];
  const stream = deps.client.fetch(
    { uid: `${cursor.lastUid + 1}:*` },
    { uid: true, envelope: true, internalDate: true, source: true },
  );
  for await (const message of stream) {
    if (!message.uid || (message.internalDate && message.internalDate < deps.since)) continue;
    if (message.source && message.source.byteLength > MAX_MAIL_BYTES) {
      throw new Error("mail exceeds limit");
    }
    uids.push(message.uid);
    if (uids.length >= IMAP_BATCH_SIZE) break;
  }

  let imported = 0;
  let skipped = 0;
  for (const uid of uids) {
    if (uid <= cursor.lastUid) {
      skipped += 1;
      continue;
    }
    const fetched = await deps.client.fetchOne(
      String(uid),
      { source: true },
      { uid: true },
    ) as Exclude<Awaited<ReturnType<ImapClient["fetchOne"]>>, false>;
    if (!fetched?.source) {
      skipped += 1;
      continue;
    }
    const parsed = await simpleParser(fetched.source, {
      skipImageLinks: true,
      skipHtmlToText: true,
    });
    const bytes = fetched.source.byteLength;
    const sha256 = createHash("sha256").update(fetched.source).digest("hex");
    const mime = "message/rfc822";
    const prepared = mailToImportInput({ mail: parsed });
    const source = await deps.sources.create(deps.scope, uploadInputSchema.parse({
      name: `${prepared.subject}.eml`,
      mime,
      bytes,
      sha256,
    }));
    const stagingKey = `opening/staging/${source.id}`;
    const finalKey = `opening/sources/${source.id}/v${source.version}`;
    await deps.upload({ key: stagingKey, bytes: fetched.source, mime });
    const privacyEpoch = await deps.privacy.getWorkspaceEpoch(deps.scope);
    await deps.sources.completeWithParseJob(deps.scope, source.id, {
      key: finalKey,
      payload: { sourceId: source.id, sourceVersion: source.version },
      privacyEpoch,
      actual: { bytes, sha256, mime },
      beforeComplete: () => deps.upload({ key: finalKey, bytes: fetched.source!, mime }),
    });
    const receipt = await deps.imports.commit(deps.scope, {
      connectionVersion: deps.connectionVersion,
      identity: {
        connectionId: deps.connectionId,
        container: deps.folder,
        generation: cursor.uidValidity,
        remoteId: String(uid),
      },
      sourceId: source.id,
      cursor: {
        generation: cursor.uidValidity,
        cursor: nextImapCursor(cursor, uid),
      },
    });
    cursor = {
      folder: deps.folder,
      uidValidity: cursor.uidValidity,
      lastUid: Math.max(cursor.lastUid, uid),
    };
    if (receipt.duplicate) skipped += 1;
    else imported += 1;
  }

  await deps.client.logout();
  return { imported, skipped, cursor };
}
