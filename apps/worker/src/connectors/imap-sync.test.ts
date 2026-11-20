import { describe, expect, it, vi } from "vitest";
import type { ImapCursor } from "@aistudy/contracts";
import { mailToImportInput, nextImapCursor, syncMailbox, type ImapSyncDeps } from "./imap-sync";
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
});
