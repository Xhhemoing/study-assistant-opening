import type { ImapCursor } from "@aistudy/contracts";
import type {
  createOpeningImportsRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, OpeningScope,
} from "@aistudy/database";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  attachImapClientErrorGuard,
  getClientErrorState,
  installImapCommandGuard,
  MAX_IMAP_FETCH_COMMAND_BYTES,
  MAX_IMAP_PROBE_COMMAND_BYTES,
  partialBodyOffsetKey,
  runGuardedImapFetch,
} from "./imap-command-guard";
import { publishConnectorSource, type ConnectorSourceStorage } from "./publish-source";

export { attachImapClientErrorGuard };

export const IMAP_BATCH_SIZE = 100;
export const DEFAULT_IMAP_SYNC_DURATION_MS = 120_000;
export const DEFAULT_IMAP_TEARDOWN_WAIT_MS = 500;
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
  maxSyncDurationMs?: number;
  deadlineMs?: number;
  teardownTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onDeadlineAbort?: () => void;
};

export async function runWithSyncDeadline<T>(
  operation: () => Promise<T>,
  options: {
    phase: string;
    deadlineMs: number;
    now: () => number;
    signal?: AbortSignal;
    client?: object;
    onDeadlineAbort: () => void;
  },
): Promise<T> {
  const { phase, deadlineMs, now, signal, client, onDeadlineAbort } = options;
  const errorState = client ? getClientErrorState(attachImapClientErrorGuard(client)) : undefined;
  if (errorState?.firstError) {
    onDeadlineAbort();
    throw errorState.firstError;
  }
  if (signal?.aborted) {
    onDeadlineAbort();
    throw new Error(`IMAP sync aborted during ${phase}`);
  }
  const remainingMs = deadlineMs - now();
  if (remainingMs < 0) {
    onDeadlineAbort();
    throw new Error(`IMAP sync exceeded time budget during ${phase}`);
  }
  const opPromise = Promise.resolve().then(operation);
  if (!signal && !errorState && remainingMs >= 2_147_483_647) {
    return opPromise;
  }
  void opPromise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onClientError: ((error: Error) => void) | undefined;
  try {
    const guard = new Promise<never>((_, reject) => {
      if (errorState) {
        onClientError = (err: Error) => {
          onDeadlineAbort();
          reject(err);
        };
        if (errorState.firstError) {
          onClientError(errorState.firstError);
          return;
        }
        errorState.waiters.add(onClientError);
      }
      if (signal) {
        onAbort = () => {
          onDeadlineAbort();
          reject(new Error(`IMAP sync aborted during ${phase}`));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (remainingMs < 2_147_483_647) {
        timer = setTimeout(() => {
          onDeadlineAbort();
          reject(new Error(`IMAP sync exceeded time budget during ${phase}`));
        }, remainingMs);
        timer.unref?.();
      }
    });
    return await Promise.race([opPromise, guard]);
  } catch (error) {
    if (errorState?.firstError) throw errorState.firstError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (onClientError) errorState?.waiters.delete(onClientError);
  }
}

/** Bounded read-only IMAP adapter. Cursor advances only after commit succeeds. */
export async function syncMailbox(deps: ImapSyncDeps): Promise<{
  imported: number;
  skipped: number;
  cursor: ImapCursor;
}> {
  installImapCommandGuard(deps.client);
  const clock = deps.now ?? (() => Date.now());
  const maxDurationMs = deps.maxSyncDurationMs ?? DEFAULT_IMAP_SYNC_DURATION_MS;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error("IMAP sync maxSyncDurationMs must be positive");
  }
  const teardownWaitMs = deps.teardownTimeoutMs ?? DEFAULT_IMAP_TEARDOWN_WAIT_MS;
  if (!Number.isFinite(teardownWaitMs) || teardownWaitMs <= 0) {
    throw new Error("IMAP sync teardownTimeoutMs must be positive");
  }
  const deadlineMs = deps.deadlineMs ?? (clock() + maxDurationMs);
  let abortHookInvoked = false;
  const invokeDeadlineAbort = () => {
    if (abortHookInvoked) return;
    abortHookInvoked = true;
    try {
      deps.onDeadlineAbort?.();
    } catch {
      // Teardown hook errors must not mask timeout or abort errors.
    }
  };
  const withDeadline = <T>(phase: string, operation: () => Promise<T>) => runWithSyncDeadline(operation, {
    phase,
    deadlineMs,
    now: clock,
    signal: deps.signal,
    client: deps.client,
    onDeadlineAbort: invokeDeadlineAbort,
  });
  const assertWithinBudget = (phase: string) => {
    if (deps.signal?.aborted) {
      invokeDeadlineAbort();
      throw new Error(`IMAP sync aborted during ${phase}`);
    }
    if (clock() > deadlineMs) {
      invokeDeadlineAbort();
      throw new Error(`IMAP sync exceeded time budget during ${phase}`);
    }
  };
  assertWithinBudget("discovery");

  const opened = await withDeadline("mailboxOpen", () => deps.client.mailboxOpen(deps.folder, { readOnly: true }));
  if (!opened) throw new Error(`folder is unavailable: ${deps.folder}`);
  const uidValidity = String(opened.uidValidity);
  let expectedCursor = deps.cursor;
  let cursor = expectedCursor?.uidValidity === uidValidity
    ? expectedCursor : { folder: deps.folder, uidValidity, lastUid: 0 };

  // Keep only the lowest batch-size distinct UIDs while the discovery stream
  // is consumed. A mailbox can contain millions of eligible messages, so do
  // not retain and sort the entire discovery result in memory.
  const eligibleUids = new Set<number>();
  const sizeByUid = new Map<number, number>();
  const stream = deps.client.fetch(
    { uid: `${cursor.lastUid + 1}:*` },
    { uid: true, internalDate: true, size: true },
  );
  const iterator = stream[Symbol.asyncIterator]();
  let discoveryFinished = false;
  try {
    while (true) {
      const step = await withDeadline("discovery", () => iterator.next());
      if (step.done) {
        discoveryFinished = true;
        break;
      }
      const message = step.value;
      assertWithinBudget("discovery");
      if (!Number.isSafeInteger(message.uid) || message.uid <= cursor.lastUid
        || (message.internalDate && message.internalDate < deps.since)) continue;
      if (eligibleUids.has(message.uid)) continue;
      if (eligibleUids.size === IMAP_BATCH_SIZE) {
        let highest = -1;
        for (const uid of eligibleUids) highest = Math.max(highest, uid);
        if (message.uid >= highest) continue;
        eligibleUids.delete(highest);
        sizeByUid.delete(highest);
      }
      eligibleUids.add(message.uid);
      if (typeof message.size === "number" && Number.isFinite(message.size)) {
        sizeByUid.set(message.uid, message.size);
      }
    }
  } finally {
    if (!discoveryFinished && typeof iterator.return === "function") {
      const returnPromise = Promise.resolve(iterator.return(undefined)).catch(() => undefined);
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<void>((resolve) => {
          teardownTimer = setTimeout(resolve, teardownWaitMs);
          teardownTimer.unref?.();
        });
        await Promise.race([returnPromise, timeout]);
      } finally {
        if (teardownTimer !== undefined) clearTimeout(teardownTimer);
      }
    }
  }
  // The server can return UIDs in any order. Sorting the bounded set keeps
  // publication and cursor advancement ascending without an unbounded array.
  const uids = [...eligibleUids].sort((a, b) => a - b).slice(0, IMAP_BATCH_SIZE);

  let imported = 0;
  let skipped = 0;
  for (const uid of uids) {
    assertWithinBudget("fetch");
    const knownSize = sizeByUid.get(uid);
    if (knownSize !== undefined && knownSize > MAX_MAIL_BYTES) {
      throw new Error("mail exceeds limit");
    }
    const identity = {
      connectionId: deps.connectionId,
      container: deps.folder,
      generation: cursor.uidValidity,
      remoteId: String(uid),
    };
    const fetched = await withDeadline("fetch", () => runGuardedImapFetch(
      deps.client,
      { maxBytes: MAX_IMAP_FETCH_COMMAND_BYTES, maxFetchResponses: 1, expectedUid: uid },
      () => deps.client.fetchOne(
        String(uid),
        { source: { start: 0, maxLength: MAX_MAIL_BYTES + 1 }, size: true },
        { uid: true },
      ),
    ));
    if (fetched === false) {
      // The message was expunged after discovery.
      skipped += 1;
      continue;
    }
    if (!fetched?.source || fetched.uid !== uid) throw new Error("IMAP body response did not match the requested UID");
    const fetchedSource = fetched.source;
    if (typeof fetched.size === "number" && fetched.size > MAX_MAIL_BYTES) {
      throw new Error("mail exceeds limit");
    }
    if (fetchedSource.byteLength > MAX_MAIL_BYTES) throw new Error("mail exceeds limit");
    const reportedSize = Math.max(
      typeof fetched.size === "number" && Number.isFinite(fetched.size) && fetched.size > 0 ? fetched.size : 0,
      knownSize !== undefined && Number.isFinite(knownSize) && knownSize > 0 ? knownSize : 0,
    );
    if (reportedSize > 0 && fetchedSource.byteLength < reportedSize) {
      const receivedBytes = fetchedSource.byteLength;
      if (receivedBytes === 0) {
        throw new Error("IMAP message body was truncated before reaching reported size");
      }
      // Exchange / Office 365 / Maildir can over-report RFC822.SIZE relative to BODY[].
      // Probe the trailing overlap window plus 1 byte: require the exact server-returned
      // BODY[]<overlapStart> offset and matching tail bytes terminating at EOF.
      const overlapStart = Math.max(0, receivedBytes - 64);
      const expectedOverlapLen = receivedBytes - overlapStart;
      const expectedOffsetKey = partialBodyOffsetKey(overlapStart);
      const probe = await withDeadline("fetch", () => runGuardedImapFetch(
        deps.client,
        { maxBytes: MAX_IMAP_PROBE_COMMAND_BYTES, maxFetchResponses: 1, expectedUid: uid, isProbe: true },
        () => deps.client.fetchOne(
          String(uid),
          { source: { start: overlapStart, maxLength: expectedOverlapLen + 1 } },
          { uid: true },
        ),
      ));
      if (probe === false) {
        // The message was expunged after the initial fetch.
        skipped += 1;
        continue;
      }
      const probeSlice = probe?.bodyParts?.get(expectedOffsetKey);
      if (
        !probe
        || probe.uid !== uid
        || !Buffer.isBuffer(probeSlice)
        || probeSlice.byteLength !== expectedOverlapLen
        || !probeSlice.equals(fetchedSource.subarray(overlapStart, receivedBytes))
      ) {
        throw new Error("IMAP message body was truncated before reaching reported size");
      }
    }
    const parsed = await simpleParser(fetchedSource, {
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

  await withDeadline("logout", () => deps.client.logout());
  return { imported, skipped, cursor };
}
