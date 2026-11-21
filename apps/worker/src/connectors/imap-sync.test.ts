import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ImapCursor } from "@aistudy/contracts";
import { partialBodyOffsetKey } from "./imap-command-guard";
import { mailToImportInput, MAX_MAIL_BYTES, nextImapCursor, runWithSyncDeadline, syncMailbox, type ImapSyncDeps } from "./imap-sync";
import { publishConnectorSource } from "./publish-source";

vi.mock("./publish-source", () => ({ publishConnectorSource: vi.fn() }));

function mailbox(discovered: number[], cursor: ImapCursor | null) {
  const published: number[] = [];
  vi.mocked(publishConnectorSource).mockImplementation(async (_imports, _storage, _scope, input) => {
    published.push(Number(input.identity.remoteId));
    return { id: "receipt", sourceIds: ["source"], duplicate: false, connectionVersion: 1 };
  });
  const fetchOne = vi.fn(async (uid: string) => ({
    uid: Number(uid), seq: Number(uid), source: Buffer.from(`Subject: UID ${uid}\r\n\r\nmessage`),
  }));
  const deps = {
    scope: { workspaceId: "workspace", ownerUserId: "owner" },
    connectionId: "connection",
    connectionVersion: 1,
    folder: "INBOX",
    cursor,
    since: new Date(0),
    client: {
      mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
      async *fetch() {
        for (const uid of discovered) yield { uid };
      },
      fetchOne,
      logout: vi.fn(),
    },
    imports: { advanceImapCursor: vi.fn() },
    storage: {},
  } as unknown as ImapSyncDeps;
  return { deps, fetchOne, published };
}

describe("IMAP UID discovery", () => {
  it("publishes unordered UIDs once in ascending order after a generation rollover", async () => {
    const { deps, fetchOne, published } = mailbox(
      [12, 11, 12, 0, -1, 13.5, Number.POSITIVE_INFINITY],
      { folder: "INBOX", uidValidity: "41", lastUid: 90 },
    );
    await expect(syncMailbox(deps)).resolves.toMatchObject({ imported: 2, cursor: { uidValidity: "42", lastUid: 12 } });
    expect(published).toEqual([11, 12]);
    expect(fetchOne.mock.calls.map(([uid]) => Number(uid))).toEqual(published);
  });

  it("processes the lowest 100 UIDs and never misses a lower UID across two batches", async () => {
    const expected = Array.from({ length: 105 }, (_, index) => index + 1);
    const { deps, fetchOne, published } = mailbox(expected.toReversed(), null);
    const first = await syncMailbox(deps);
    expect(first).toMatchObject({ imported: 100, cursor: { lastUid: 100 } });
    expect(published).toEqual(expected.slice(0, 100));
    const second = await syncMailbox({ ...deps, cursor: first.cursor });
    expect(second).toMatchObject({ imported: 5, cursor: { lastUid: 105 } });
    expect(published).toEqual(expected);
    expect(fetchOne.mock.calls.map(([uid]) => Number(uid))).toEqual(expected);
  });
});

describe("imap sync cursor and parser guards", () => {
  it("never moves a committed UID cursor backwards", () => {
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 10 }, 9).lastUid).toBe(10);
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 10 }, 12).lastUid).toBe(12);
  });

  it("keeps mailbox generations separate", () => {
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 0 }, 12))
      .toEqual({ folder: "INBOX", uidValidity: "7", lastUid: 12 });
  });

  it("parses bounded text mail without remote content or path-like attachment names", () => {
    const input = mailToImportInput({
      mail: {
        subject: "Lesson",
        text: "hello",
        html: "<p>remote</p>",
        attachments: [{
          filename: "../evil.png",
          contentType: "image/png",
          content: new Uint8Array([1, 2, 3]),
        }],
      },
    });
    expect(input.subject).toBe("Lesson");
    expect(input.bodyText).toBe("hello");
    expect(input.attachments[0]?.filename).toBe("evil.png");
    expect(input.attachments[0]?.size).toBe(3);
  });

  it("rejects oversized mail from discovery metadata before fetching its body", async () => {
    const fetchOne = vi.fn();
    const deps = {
      scope: { workspaceId: "workspace", ownerUserId: "owner" },
      connectionId: "connection",
      connectionVersion: 1,
      folder: "INBOX",
      cursor: null,
      since: new Date(0),
      client: {
        mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
        async *fetch() {
          yield { uid: 15, size: MAX_MAIL_BYTES + 1 };
        },
        fetchOne,
        logout: vi.fn(),
      },
      imports: { advanceImapCursor: vi.fn() },
      storage: {},
    } as unknown as ImapSyncDeps;

    await expect(syncMailbox(deps)).rejects.toThrow("mail exceeds limit");
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it("requests a bounded partial body + size and rejects if server under-reported size in discovery", async () => {
    const fetchOne = vi.fn(async (uid: string) => ({
      uid: Number(uid),
      seq: Number(uid),
      size: MAX_MAIL_BYTES + 10,
      source: Buffer.from("Subject: Truncated\r\n\r\nhi"),
    }));
    const deps = {
      scope: { workspaceId: "workspace", ownerUserId: "owner" },
      connectionId: "connection",
      connectionVersion: 1,
      folder: "INBOX",
      cursor: null,
      since: new Date(0),
      client: {
        mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
        async *fetch() {
          yield { uid: 21, size: 128 };
        },
        fetchOne,
        logout: vi.fn(),
      },
      imports: { advanceImapCursor: vi.fn() },
      storage: {},
    } as unknown as ImapSyncDeps;

    await expect(syncMailbox(deps)).rejects.toThrow("mail exceeds limit");
    expect(fetchOne).toHaveBeenCalledWith(
      "21",
      { source: { start: 0, maxLength: MAX_MAIL_BYTES + 1 }, size: true },
      { uid: true },
    );
  });

  it("rejects a truncated body when the trailing offset-overlap probe fails offset, length, or content proof without saving .eml or advancing the UID cursor", async () => {
    const truncatedHeaderAndBody = "Subject: Partial Delivery\r\nContent-Type: text/plain\r\n\r\n";
    const truncatedSource = Buffer.from(
      truncatedHeaderAndBody + "x".repeat(180 - Buffer.byteLength(truncatedHeaderAndBody)),
      "utf8",
    );
    expect(truncatedSource.byteLength).toBe(180);

    const completeSource = Buffer.from("Subject: UID 30\r\n\r\ncomplete message", "utf8");
    const runTruncationScenario = async (
      probeResponse: { uid: number; seq: number; source?: Buffer; bodyParts?: Map<string, Buffer> },
      withUid30 = false,
    ) => {
      const published: number[] = [];
      vi.mocked(publishConnectorSource).mockReset();
      vi.mocked(publishConnectorSource).mockImplementation(async (_imports, storage, _scope, input) => {
        await storage.upload({ key: `opening/sources/${input.identity.remoteId}/v0`, bytes: input.bytes, mime: input.mime });
        published.push(Number(input.identity.remoteId));
        return { id: `receipt-${input.identity.remoteId}`, sourceIds: [`source-${input.identity.remoteId}`], duplicate: false, connectionVersion: 1 };
      });
      const upload = vi.fn(async () => undefined);
      const advanceImapCursor = vi.fn();
      const fetchOne = vi.fn(async (uid: string, query: { source?: { start?: number; maxLength?: number } }) => {
        if (uid === "30") {
          return { uid: 30, seq: 1, size: completeSource.byteLength, source: completeSource };
        }
        if (query.source?.start === 116 && query.source?.maxLength === 65) {
          return probeResponse;
        }
        return { uid: 31, seq: withUid30 ? 2 : 1, size: 4096, source: truncatedSource };
      });
      const deps = {
        scope: { workspaceId: "workspace", ownerUserId: "owner" },
        connectionId: "connection",
        connectionVersion: 1,
        folder: "INBOX",
        cursor: withUid30 ? { folder: "INBOX", uidValidity: "42", lastUid: 29 } : null,
        since: new Date(0),
        client: {
          mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
          async *fetch() {
            if (withUid30) yield { uid: 30, size: completeSource.byteLength };
            yield { uid: 31, size: 4096 };
          },
          fetchOne,
          logout: vi.fn(),
        },
        imports: { advanceImapCursor },
        storage: { upload, remove: vi.fn() },
      } as unknown as ImapSyncDeps;

      await expect(syncMailbox(deps)).rejects.toThrow("IMAP message body was truncated before reaching reported size");
      expect(fetchOne).toHaveBeenCalledWith("31", { source: { start: 116, maxLength: 65 } }, { uid: true });
      expect(published).toEqual(withUid30 ? [30] : []);
      expect(upload).toHaveBeenCalledTimes(withUid30 ? 1 : 0);
      expect(upload).not.toHaveBeenCalledWith(expect.objectContaining({ bytes: truncatedSource }));
      expect(advanceImapCursor).not.toHaveBeenCalled();
    };

    // (a) Wrong offset <0> "" (even with preceding UID 30 imported, UID 31 fails and cursor stops at 30)
    await runTruncationScenario({ uid: 31, seq: 2, source: Buffer.alloc(0), bodyParts: new Map([[partialBodyOffsetKey(0), Buffer.alloc(0)]]) }, true);
    // (b) Wrong offset <9999> ""
    await runTruncationScenario({ uid: 31, seq: 1, source: Buffer.alloc(0), bodyParts: new Map([[partialBodyOffsetKey(9999), Buffer.alloc(0)]]) });
    // (c) Un-offset BODY[] without <116>
    await runTruncationScenario({ uid: 31, seq: 1, source: truncatedSource.subarray(116, 180), bodyParts: new Map([["BODY[]", truncatedSource.subarray(116, 180)]]) });
    // (d) Probe returns 65 bytes (expectedOverlapLen + 1 => more bytes exist past 180)
    await runTruncationScenario({
      uid: 31,
      seq: 1,
      bodyParts: new Map([[partialBodyOffsetKey(116), Buffer.concat([truncatedSource.subarray(116, 180), Buffer.from("y")])]]),
    });
    // (e) Probe returns 64 bytes at <116> whose bytes differ from the initial fetch's tail
    await runTruncationScenario({
      uid: 31,
      seq: 1,
      bodyParts: new Map([[partialBodyOffsetKey(116), Buffer.alloc(64, "z")]]),
    });

    // (f) 0-byte initial fetch fails immediately without issuing a probe
    const emptyFetchOne = vi.fn(async () => ({ uid: 31, seq: 1, size: 4096, source: Buffer.alloc(0) }));
    await expect(syncMailbox({
      scope: { workspaceId: "workspace", ownerUserId: "owner" },
      connectionId: "connection",
      connectionVersion: 1,
      folder: "INBOX",
      cursor: null,
      since: new Date(0),
      client: {
        mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
        async *fetch() {
          yield { uid: 31, size: 4096 };
        },
        fetchOne: emptyFetchOne,
        logout: vi.fn(),
      },
      imports: { advanceImapCursor: vi.fn() },
      storage: { upload: vi.fn(), remove: vi.fn() },
    } as unknown as ImapSyncDeps)).rejects.toThrow("IMAP message body was truncated before reaching reported size");
    expect(emptyFetchOne).toHaveBeenCalledTimes(1);
  });

  it("imports complete messages with inflated RFC822.SIZE when BODY[]<overlapStart> returns exact matching tail bytes", async () => {
    const headerAndBody = "Subject: Inflated Size\r\nContent-Type: text/plain\r\n\r\n";
    const complete180 = Buffer.from(
      headerAndBody + "a".repeat(180 - Buffer.byteLength(headerAndBody)),
      "utf8",
    );
    const short40Header = "Subject: Short\r\n\r\n";
    const complete40 = Buffer.from(short40Header + "b".repeat(40 - Buffer.byteLength(short40Header)), "utf8");
    expect(complete180.byteLength).toBe(180);
    expect(complete40.byteLength).toBe(40);

    const published: number[] = [];
    vi.mocked(publishConnectorSource).mockReset();
    vi.mocked(publishConnectorSource).mockImplementation(async (_imports, storage, _scope, input) => {
      await storage.upload({ key: `opening/sources/${input.identity.remoteId}/v0`, bytes: input.bytes, mime: input.mime });
      published.push(Number(input.identity.remoteId));
      return { id: `receipt-${input.identity.remoteId}`, sourceIds: [`source-${input.identity.remoteId}`], duplicate: false, connectionVersion: 1 };
    });

    const upload = vi.fn(async () => undefined);
    const fetchOne = vi.fn(async (uid: string, query: { source?: { start?: number; maxLength?: number } }) => {
      if (uid === "41") {
        return query.source?.start === 116 && query.source?.maxLength === 65
          ? { uid: 41, seq: 1, source: complete180.subarray(116, 180), bodyParts: new Map([[partialBodyOffsetKey(116), complete180.subarray(116, 180)]]) }
          : { uid: 41, seq: 1, size: 220, source: complete180 };
      }
      return query.source?.start === 0 && query.source?.maxLength === 41
        ? { uid: 42, seq: 2, source: complete40, bodyParts: new Map([[partialBodyOffsetKey(0), complete40]]) }
        : { uid: 42, seq: 2, size: 80, source: complete40 };
    });
    const deps = {
      scope: { workspaceId: "workspace", ownerUserId: "owner" },
      connectionId: "connection",
      connectionVersion: 1,
      folder: "INBOX",
      cursor: { folder: "INBOX", uidValidity: "42", lastUid: 40 },
      since: new Date(0),
      client: {
        mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
        async *fetch() {
          yield { uid: 41, size: 220 };
          yield { uid: 42, size: 80 };
        },
        fetchOne,
        logout: vi.fn(),
      },
      imports: { advanceImapCursor: vi.fn() },
      storage: { upload, remove: vi.fn() },
    } as unknown as ImapSyncDeps;

    await expect(syncMailbox(deps)).resolves.toMatchObject({
      imported: 2,
      skipped: 0,
      cursor: { folder: "INBOX", uidValidity: "42", lastUid: 42 },
    });
    expect(fetchOne).toHaveBeenCalledWith("41", { source: { start: 116, maxLength: 65 } }, { uid: true });
    expect(fetchOne).toHaveBeenCalledWith("42", { source: { start: 0, maxLength: 41 } }, { uid: true });
    expect(published).toEqual([41, 42]);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ bytes: complete180 }));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ bytes: complete40 }));
  });

  it("treats a message concurrently expunged during the trailing overlap probe as skipped without advancing cursor past it", async () => {
    const headerAndBody = "Subject: Expunged Mid-Fetch\r\n\r\n";
    const body = Buffer.from(headerAndBody + "z".repeat(180 - Buffer.byteLength(headerAndBody)), "utf8");
    vi.mocked(publishConnectorSource).mockReset();

    const upload = vi.fn(async () => undefined);
    const advanceImapCursor = vi.fn();
    const deps = {
      scope: { workspaceId: "workspace", ownerUserId: "owner" },
      connectionId: "connection",
      connectionVersion: 1,
      folder: "INBOX",
      cursor: { folder: "INBOX", uidValidity: "42", lastUid: 50 },
      since: new Date(0),
      client: {
        mailboxOpen: vi.fn(async () => ({ uidValidity: 42n })),
        async *fetch() {
          yield { uid: 51, size: 4096 };
        },
        fetchOne: vi.fn(async (_uid: string, query: { source?: { start?: number; maxLength?: number } }) => (
          query.source?.start === 116 && query.source?.maxLength === 65
            ? false
            : { uid: 51, seq: 1, size: 4096, source: body }
        )),
        logout: vi.fn(),
      },
      imports: { advanceImapCursor },
      storage: { upload, remove: vi.fn() },
    } as unknown as ImapSyncDeps;

    await expect(syncMailbox(deps)).resolves.toMatchObject({
      imported: 0,
      skipped: 1,
      cursor: { folder: "INBOX", uidValidity: "42", lastUid: 50 },
    });
    expect(publishConnectorSource).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(advanceImapCursor).not.toHaveBeenCalled();
  });

  it("stops discovery cleanly when elapsed sync time budget or signal expires", async () => {
    let returned = false;
    let tick = 1000;
    const { deps } = mailbox([], null);
    deps.now = () => tick;
    deps.maxSyncDurationMs = 50;
    deps.client.fetch = (() => ({
      async *[Symbol.asyncIterator]() {
        try {
          tick += 10;
          yield { uid: 1 };
          tick += 100;
          yield { uid: 2 };
        } finally {
          returned = true;
        }
      },
    })) as unknown as ImapSyncDeps["client"]["fetch"];

    await expect(syncMailbox(deps)).rejects.toThrow("IMAP sync exceeded time budget during discovery");
    expect(returned).toBe(true);

    let stalledReturned = false;
    const stalled = mailbox([], null);
    stalled.deps.maxSyncDurationMs = 15;
    stalled.deps.client.fetch = (() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<{ uid: number }>>(() => undefined),
          return: async () => {
            stalledReturned = true;
            return { value: undefined, done: true as const };
          },
        };
      },
    })) as unknown as ImapSyncDeps["client"]["fetch"];

    await expect(syncMailbox(stalled.deps)).rejects.toThrow("IMAP sync exceeded time budget during discovery");
    expect(stalledReturned).toBe(true);

    const ac = new AbortController();
    ac.abort();
    const aborted = mailbox([1], null);
    aborted.deps.signal = ac.signal;
    await expect(syncMailbox(aborted.deps)).rejects.toThrow("IMAP sync aborted during discovery");
  });

  it("invokes onDeadlineAbort and does not hang behind a stalled iterator.return()", async () => {
    const onDeadlineAbort = vi.fn();
    let returnCalled = false;
    const stalled = mailbox([], null);
    stalled.deps.maxSyncDurationMs = 15;
    stalled.deps.teardownTimeoutMs = 25;
    stalled.deps.onDeadlineAbort = onDeadlineAbort;
    stalled.deps.client.fetch = (() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<{ uid: number }>>(() => undefined),
          return: () => {
            returnCalled = true;
            return new Promise<IteratorResult<{ uid: number }>>(() => undefined);
          },
        };
      },
    })) as unknown as ImapSyncDeps["client"]["fetch"];

    const startedAt = Date.now();
    await expect(syncMailbox(stalled.deps)).rejects.toThrow("IMAP sync exceeded time budget during discovery");
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(returnCalled).toBe(true);
    expect(onDeadlineAbort).toHaveBeenCalledOnce();
  });

  it.each(["mailboxOpen", "fetch", "logout"] as const)(
    "bounds %s under the shared sync deadline and triggers onDeadlineAbort",
    async phase => {
      const base = mailbox([1], null);
      const onDeadlineAbort = vi.fn();
      base.deps.maxSyncDurationMs = 20;
      base.deps.onDeadlineAbort = onDeadlineAbort;
      if (phase === "mailboxOpen") {
        base.deps.client.mailboxOpen = (() => new Promise(() => undefined)) as ImapSyncDeps["client"]["mailboxOpen"];
      } else if (phase === "fetch") {
        base.deps.client.fetchOne = (() => new Promise(() => undefined)) as ImapSyncDeps["client"]["fetchOne"];
      } else {
        base.deps.client.logout = (() => new Promise(() => undefined)) as ImapSyncDeps["client"]["logout"];
      }
      await expect(syncMailbox(base.deps)).rejects.toThrow(`IMAP sync exceeded time budget during ${phase}`);
      expect(onDeadlineAbort).toHaveBeenCalledOnce();
    },
  );

  it("bounds stalled connect under runWithSyncDeadline and invokes onDeadlineAbort", async () => {
    const onDeadlineAbort = vi.fn();
    await expect(runWithSyncDeadline(() => new Promise(() => undefined), {
      phase: "connect",
      deadlineMs: Date.now() + 20,
      now: Date.now,
      onDeadlineAbort,
    })).rejects.toThrow("IMAP sync exceeded time budget during connect");
    expect(onDeadlineAbort).toHaveBeenCalledOnce();
  });

  it("captures emitter client error events during syncMailbox and prefers them over generic close errors", async () => {
    const base = mailbox([1], null);
    const emitter = new EventEmitter();
    const wireError = Object.assign(new Error("Line length exceeds maximum allowed size"), { code: "LineTooLarge" });
    const client = Object.assign(emitter, {
      ...base.deps.client,
      close: vi.fn(),
      fetchOne: (() => new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          emitter.emit("error", wireError);
          reject(new Error("Connection closed"));
        }, 5);
      })) as ImapSyncDeps["client"]["fetchOne"],
    });
    base.deps.client = client as unknown as ImapSyncDeps["client"];
    base.deps.onDeadlineAbort = () => client.close();

    await expect(syncMailbox(base.deps)).rejects.toBe(wireError);
    expect(client.close).toHaveBeenCalled();
  });
});
