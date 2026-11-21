import { describe, expect, it, vi } from "vitest";
import { installImapCommandGuard, partialBodyOffsetKey, runGuardedImapFetch } from "./imap-command-guard";

function atom(value: string, section?: unknown[], partial?: number[]) {
  return {
    type: "ATOM",
    value,
    ...(section !== undefined ? { section } : {}),
    ...(partial !== undefined ? { partial } : {}),
  };
}

function makeUntaggedFetch(seq: number, list: unknown[]) {
  return { command: String(seq), attributes: [{ type: "ATOM", value: "FETCH" }, list] };
}

function createFakeClient(handlers: {
  onExec: (ctx: {
    command: string;
    attributes: unknown;
    onSend?: () => void;
    emitWire: (bytes: number) => void;
    emitUntaggedFetch: (untagged: unknown) => Promise<void>;
    messagesList: unknown[];
  }) => Promise<void>;
}) {
  const socketListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const socket = {
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = socketListeners.get(event) ?? [];
      list.push(fn);
      socketListeners.set(event, list);
    },
    removeListener(event: string, fn: (...args: unknown[]) => void) {
      const list = socketListeners.get(event) ?? [];
      socketListeners.set(event, list.filter((item) => item !== fn));
    },
  };
  const emitWire = (bytes: number) => {
    const buf = Buffer.alloc(bytes, 0x78);
    for (const fn of socketListeners.get("data") ?? []) fn(buf);
  };
  const untaggedFetch = vi.fn(async () => undefined);
  const close = vi.fn();

  const client = {
    socket,
    close,
    untaggedFetch,
    async exec(command: string, attributes: unknown, options?: {
      onSend?: () => void;
      untagged?: { FETCH?: (untagged: unknown) => Promise<void> | void };
    }) {
      options?.onSend?.();
      const messagesList: unknown[] = [];
      await handlers.onExec({
        command,
        attributes,
        onSend: options?.onSend,
        emitWire,
        messagesList,
        emitUntaggedFetch: async (untagged: unknown) => {
          await options?.untagged?.FETCH?.(untagged);
        },
      });
      return { list: messagesList };
    },
    async fetchOne(seq: string, query: { source?: unknown }, options?: { uid?: boolean }) {
      const items: unknown[] = [atom("UID")];
      if ((query as { flags?: boolean }).flags) items.push(atom("FLAGS"));
      if ((query as { size?: boolean }).size) items.push(atom("RFC822.SIZE"));
      if (query.source) items.push(atom("BODY.PEEK", [], [0, 1024]));
      const messagesList: unknown[] = [];
      await client.exec(
        options?.uid ? "UID FETCH" : "FETCH",
        [atom(seq), items],
        {
          untagged: {
            FETCH: async (untagged: unknown) => {
              const list = (untagged as { attributes?: unknown[] }).attributes?.[1] as unknown[];
              messagesList.push({ untagged, list });
            },
          },
        },
      );
      return messagesList.length ? messagesList[0] : false;
    },
  };

  return { client, untaggedFetch, close };
}

describe("imap-command-guard unsolicited FLAGS handling", () => {
  it("passes unsolicited FLAGS/MODSEQ notifications to untaggedFetch before and after target UID FETCH without aborting or polluting messages", async () => {
    const bodyBuf = Buffer.from("Subject: OK\r\n\r\nbody");
    const fake = createFakeClient({
      onExec: async ({ emitWire, emitUntaggedFetch }) => {
        emitWire(64);
        // Unsolicited flag update for another sequence without UID arrives BEFORE target body.
        await emitUntaggedFetch(makeUntaggedFetch(2, [atom("FLAGS"), [atom("\\Seen")]]));
        // Real target UID FETCH response arrives cleanly.
        await emitUntaggedFetch(
          makeUntaggedFetch(1, [
            atom("UID"), atom("11"),
            atom("RFC822.SIZE"), atom(String(bodyBuf.byteLength)),
            atom("BODY", [], [0]), { type: "LITERAL", value: bodyBuf },
          ]),
        );
        // Unsolicited flag + MODSEQ update even with same UID 11 arrives AFTER target body.
        await emitUntaggedFetch(
          makeUntaggedFetch(1, [
            atom("UID"), atom("11"),
            atom("FLAGS"), [atom("\\Seen"), atom("\\Answered")],
            atom("MODSEQ"), [atom("98765")],
          ]),
        );
      },
    });

    const guarded = installImapCommandGuard(fake.client);
    guarded.on = (() => guarded) as unknown as typeof fake.client & ((...args: unknown[]) => unknown);
    const result = await runGuardedImapFetch(
      guarded,
      { maxBytes: 64 * 1024, maxFetchResponses: 1, expectedUid: 11, expectedStartOffset: 0 },
      () => guarded.fetchOne("11", { source: { start: 0, maxLength: 1024 }, size: true }, { uid: true }),
    );

    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.untaggedFetch).toHaveBeenCalledTimes(2);
    expect(result).toBeTruthy();
    expect((result as { bodyParts?: Map<string, Buffer> }).bodyParts?.get(partialBodyOffsetKey(0))).toEqual(bodyBuf);
  });

  it("returns false (expunged) when OK follows unsolicited FLAGS without any target FETCH response", async () => {
    const fake = createFakeClient({
      onExec: async ({ emitUntaggedFetch }) => {
        await emitUntaggedFetch(makeUntaggedFetch(2, [atom("FLAGS"), [atom("\\Deleted")]]));
      },
    });
    const guarded = installImapCommandGuard(fake.client);
    const result = await runGuardedImapFetch(
      guarded,
      { maxBytes: 64 * 1024, maxFetchResponses: 1, expectedUid: 11, expectedStartOffset: 0 },
      () => guarded.fetchOne("11", { source: { start: 0, maxLength: 1024 }, size: true }, { uid: true }),
    );
    expect(result).toBe(false);
    expect(fake.untaggedFetch).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("routes unsolicited FLAGS cleanly during discovery FETCH without counting against maxDiscoveryResponses", async () => {
    const targetEvents: unknown[] = [];
    const fake = createFakeClient({
      onExec: async ({ emitUntaggedFetch }) => {
        for (let i = 1; i <= 5; i += 1) {
          await emitUntaggedFetch(makeUntaggedFetch(i, [atom("FLAGS"), [atom("\\Seen")], atom("UID"), atom(String(i))]));
        }
        await emitUntaggedFetch(makeUntaggedFetch(1, [atom("UID"), atom("101"), atom("RFC822.SIZE"), atom("10")]));
        await emitUntaggedFetch(makeUntaggedFetch(2, [atom("UID"), atom("102"), atom("RFC822.SIZE"), atom("10")]));
      },
    });
    const guarded = installImapCommandGuard(fake.client, { maxDiscoveryResponses: 2 });
    await guarded.exec("UID FETCH", [atom("1:5000"), [atom("UID"), atom("RFC822.SIZE")]], {
      untagged: {
        FETCH: async (u) => { targetEvents.push(u); },
      },
    });
    expect(targetEvents).toHaveLength(2);
    expect(fake.untaggedFetch).toHaveBeenCalledTimes(5);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("still enforces maxBytes against an unsolicited FLAGS flood and rejects spoofed or duplicate non-flag responses", async () => {
    const bodyBuf = Buffer.from("Subject: OK\r\n\r\nbody");

    // 1. Wire flood of unsolicited FLAGS exceeds maxBytes.
    const floodFake = createFakeClient({
      onExec: async ({ emitWire, emitUntaggedFetch }) => {
        for (let i = 0; i < 20; i += 1) {
          emitWire(256);
          await emitUntaggedFetch(makeUntaggedFetch(1, [atom("FLAGS"), [atom("\\Seen")]]));
        }
      },
    });
    const guardedFlood = installImapCommandGuard(floodFake.client, { maxFetchCommandBytes: 1024 });
    await expect(
      runGuardedImapFetch(
        guardedFlood,
        { maxBytes: 1024, maxFetchResponses: 1, expectedUid: 11, expectedStartOffset: 0 },
        () => guardedFlood.fetchOne("11", { source: { start: 0, maxLength: 1024 } }, { uid: true }),
      ),
    ).rejects.toThrow(/exceeded 1024 bytes/);
    expect(floodFake.close).toHaveBeenCalled();

    // 2. Spoofed response with FLAGS + RFC822.SIZE (or FLAGS + Buffer literal) is NOT treated as pure notification.
    const mixedFake = createFakeClient({
      onExec: async ({ emitUntaggedFetch }) => {
        await emitUntaggedFetch(
          makeUntaggedFetch(1, [atom("UID"), atom("11"), atom("FLAGS"), [atom("\\Seen")], atom("RFC822.SIZE"), atom("999")]),
        );
      },
    });
    const guardedMixed = installImapCommandGuard(mixedFake.client);
    await expect(
      runGuardedImapFetch(
        guardedMixed,
        { maxBytes: 64 * 1024, maxFetchResponses: 1, expectedUid: 11, expectedStartOffset: 0 },
        () => guardedMixed.fetchOne("11", { source: { start: 0, maxLength: 1024 }, size: true }, { uid: true }),
      ),
    ).rejects.toThrow("IMAP message body offset did not match requested start 0");

    // 3. Two target responses separated by unsolicited FLAGS still trip maxFetchResponses: 1.
    const dupFake = createFakeClient({
      onExec: async ({ emitUntaggedFetch }) => {
        await emitUntaggedFetch(makeUntaggedFetch(1, [atom("UID"), atom("11"), atom("BODY", [], [0]), { type: "LITERAL", value: bodyBuf }]));
        await emitUntaggedFetch(makeUntaggedFetch(2, [atom("FLAGS"), [atom("\\Seen")]]));
        await emitUntaggedFetch(makeUntaggedFetch(1, [atom("UID"), atom("11"), atom("BODY", [], [0]), { type: "LITERAL", value: bodyBuf }]));
      },
    });
    const guardedDup = installImapCommandGuard(dupFake.client);
    await expect(
      runGuardedImapFetch(
        guardedDup,
        { maxBytes: 64 * 1024, maxFetchResponses: 1, expectedUid: 11, expectedStartOffset: 0 },
        () => guardedDup.fetchOne("11", { source: { start: 0, maxLength: 1024 } }, { uid: true }),
      ),
    ).rejects.toThrow("IMAP single-message fetch received unexpected multiple FETCH responses");

    // 4. Explicit FLAGS request still passes FLAGS responses through origUntaggedFetch.
    const explicitFake = createFakeClient({
      onExec: async ({ emitUntaggedFetch }) => {
        await emitUntaggedFetch(makeUntaggedFetch(1, [atom("UID"), atom("11"), atom("FLAGS"), [atom("\\Seen")]]));
      },
    });
    const guardedExplicit = installImapCommandGuard(explicitFake.client);
    const explicitResult = await guardedExplicit.fetchOne("11", { flags: true } as unknown as { source?: unknown }, { uid: true });
    expect(explicitResult).toBeTruthy();
    expect(explicitFake.untaggedFetch).not.toHaveBeenCalled();
  });
});
