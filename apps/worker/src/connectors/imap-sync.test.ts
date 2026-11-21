import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ImapCursor } from "@aistudy/contracts";
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
