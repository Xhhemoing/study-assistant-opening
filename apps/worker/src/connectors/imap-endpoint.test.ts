import net, { type AddressInfo, type NetConnectOpts } from "node:net";
import tls from "node:tls";
import { ImapFlow } from "imapflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApprovedImapClient,
  installImapCommandGuard,
  MAX_IMAP_CONTROL_COMMAND_BYTES,
  MAX_IMAP_FETCH_COMMAND_BYTES,
  MAX_IMAP_LINE_BYTES,
  MAX_IMAP_LITERAL_BYTES,
  MAX_IMAP_PROBE_COMMAND_BYTES,
  MAX_IMAP_RESPONSE_BYTES,
} from "./imap-endpoint";
import { partialBodyOffsetKey } from "./imap-command-guard";
import { runWithSyncDeadline, syncMailbox, type ImapSyncDeps } from "./imap-sync";

vi.mock("./publish-source", () => ({ publishConnectorSource: vi.fn(async () => ({ id: "receipt", sourceIds: ["src"], duplicate: false, connectionVersion: 1 })) }));

const host = "imap.example.edu";
const approvedIp = "1.1.1.1";
const endpoint = { host, port: 143, tlsMode: "starttls" };
const auth = { user: "fixture-user", pass: "fixture-password" };
const publicAnswers = () => Promise.resolve([{ address: approvedIp, family: 4 }]);

beforeEach(() => vi.stubEnv("OPENING_IMAP_ALLOWED_HOSTS", host));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("approved IMAP dialer", () => {
  it.each(["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"])(
    "rejects all answers when any address is internal (%s)", async address => {
      const connect = vi.spyOn(net, "connect");
      const resolve = async () => [...await publicAnswers(), { address, family: net.isIP(address) }];
      await expect(createApprovedImapClient(endpoint, auth, resolve)).rejects.toThrow("IMAP host is not authorized");
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each([["unlisted.example.edu", 143], [host, 993]])("rejects %s:%s before DNS lookup", async (host, port) => {
    const resolve = vi.fn(publicAnswers);
    await expect(createApprovedImapClient({ ...endpoint, host, port }, auth, resolve)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["missing", "refused", "handshake failure"])(
    "closes the pinned socket before sending credentials when STARTTLS is %s", async scenario => {
      const commands: string[] = [];
      const capabilities = scenario === "missing" ? "IMAP4rev1" : "IMAP4rev1 STARTTLS";
      const server = net.createServer(socket => {
        socket.write(`* OK [CAPABILITY ${capabilities}] ready\r\n`);
        let buffered = "";
        socket.on("data", bytes => {
          buffered += bytes.toString();
          for (let end = buffered.indexOf("\r\n"); end >= 0; end = buffered.indexOf("\r\n")) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            commands.push(line);
            const [tag, command] = line.split(" ");
            if (command === "CAPABILITY") socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK capabilities\r\n`);
            else if (command === "STARTTLS" && scenario === "refused") socket.write(`${tag} NO TLS unavailable\r\n`);
            else if (command === "STARTTLS") {
              socket.removeAllListeners("data");
              socket.once("data", () => socket.destroy());
              socket.write(`${tag} OK start TLS\r\n`);
            } else socket.destroy();
          }
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const realConnect = net.connect;
      const connect = vi.spyOn(net, "connect").mockImplementation(((options: NetConnectOpts, ready: () => void) =>
        realConnect({ ...options, host: "127.0.0.1", port }, ready)) as typeof net.connect);
      const upgrade = vi.spyOn(tls, "connect");
      const resolver = vi.fn(publicAnswers);
      const client = await createApprovedImapClient(endpoint, auth, resolver);
      try {
        await expect(client.connect()).rejects.toThrow();
        expect(resolver).toHaveBeenCalledExactlyOnceWith(host);
        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: approvedIp, port: 143, servername: host }), expect.any(Function));
        expect(commands.some(command => /\b(?:LOGIN|AUTHENTICATE)\b|fixture-(?:user|password)/.test(command))).toBe(false);
        expect(commands.some(command => command.endsWith(" STARTTLS"))).toBe(scenario !== "missing");
        if (scenario === "handshake failure") {
          expect(upgrade).toHaveBeenCalledWith(expect.objectContaining({ host: approvedIp, servername: host, rejectUnauthorized: true, socket: expect.any(net.Socket) }), expect.any(Function));
        }
      } finally {
        client.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    },
  );

  it("configures bounded line, literal, response, and command byte limits on ImapFlow", async () => {
    const client = await createApprovedImapClient(endpoint, auth, publicAnswers);
    expect(client.options.maxLineLength).toBe(MAX_IMAP_LINE_BYTES);
    expect(client.options.maxLiteralSize).toBe(MAX_IMAP_LITERAL_BYTES);
    expect(client.options.maxResponseSize).toBe(MAX_IMAP_RESPONSE_BYTES);
    expect(MAX_IMAP_LITERAL_BYTES).toBeGreaterThan(25 * 1024 * 1024);
    expect(MAX_IMAP_LITERAL_BYTES).toBeLessThan(64 * 1024 * 1024);
    expect(MAX_IMAP_RESPONSE_BYTES).toBeGreaterThan(MAX_IMAP_LITERAL_BYTES);
    expect(MAX_IMAP_FETCH_COMMAND_BYTES).toBe(MAX_IMAP_RESPONSE_BYTES + 64 * 1024);
    expect(MAX_IMAP_CONTROL_COMMAND_BYTES).toBe(MAX_IMAP_RESPONSE_BYTES + 64 * 1024);
    expect(MAX_IMAP_PROBE_COMMAND_BYTES).toBe(64 * 1024);
    client.close();
  });

  it("contains post-connect client error events and surfaces the wire error instead of closing generically", async () => {
    const client = await createApprovedImapClient(endpoint, auth, publicAnswers);
    const closeSpy = vi.spyOn(client, "close");
    const wireError = Object.assign(new Error("Literal size exceeds maximum"), { code: "LiteralTooLarge" });

    // Emitting 'error' before or outside an awaited command must not trigger ERR_UNHANDLED_ERROR.
    const inflight = runWithSyncDeadline(
      () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          client.emit("error", wireError);
          reject(new Error("Connection closed"));
        }, 5);
      }),
      {
        phase: "fetch",
        deadlineMs: Date.now() + 5000,
        now: Date.now,
        client,
        onDeadlineAbort: () => client.close(),
      },
    );
    await expect(inflight).rejects.toBe(wireError);
    expect(closeSpy).toHaveBeenCalled();

    // Emitting another error directly while idle also stays contained without crashing the process.
    expect(() => client.emit("error", new Error("post-close socket error"))).not.toThrow();
    client.close();
  });

  it("verifies partial BODY[]<offset> in ImapFlow 2.2.5 across truncated, mismatched, wrong-offset, and complete inflated-size messages", async () => {
    const body180 = Buffer.from("Subject: Probe\r\n\r\n" + "x".repeat(162), "utf8");
    const body40 = Buffer.from("Subject: Short\r\n\r\n" + "y".repeat(22), "utf8");
    expect(body180.byteLength).toBe(180);
    expect(body40.byteLength).toBe(40);

    type WireCase = {
      uid: number;
      body: Buffer;
      reportedSize: number;
      probeWireReply: (tag: string) => Buffer;
      expectAccept: boolean;
    };

    const cases: WireCase[] = [
      {
        uid: 11,
        body: body180,
        reportedSize: 4096,
        // (a) Wrong offset <0> "" -> must be rejected
        probeWireReply: (tag) => Buffer.from(`* 1 FETCH (UID 11 BODY[]<0> {0}\r\n)\r\n${tag} OK done\r\n`, "utf8"),
        expectAccept: false,
      },
      {
        uid: 12,
        body: body180,
        reportedSize: 4096,
        // (b) Wrong offset <9999> "" -> must be rejected
        probeWireReply: (tag) => Buffer.from(`* 1 FETCH (UID 12 BODY[]<9999> {0}\r\n)\r\n${tag} OK done\r\n`, "utf8"),
        expectAccept: false,
      },
      {
        uid: 13,
        body: body180,
        reportedSize: 4096,
        // (c) Genuinely truncated: probe at <116.65> returns 65 bytes
        probeWireReply: (tag) => Buffer.concat([
          Buffer.from("* 1 FETCH (UID 13 BODY[]<116> {65}\r\n", "utf8"),
          body180.subarray(116, 180),
          Buffer.from("Z)\r\n", "utf8"),
          Buffer.from(`${tag} OK done\r\n`, "utf8"),
        ]),
        expectAccept: false,
      },
      {
        uid: 14,
        body: body180,
        reportedSize: 4096,
        // (d) Mismatching tail bytes at exact offset <116>
        probeWireReply: (tag) => Buffer.concat([
          Buffer.from("* 1 FETCH (UID 14 BODY[]<116> {64}\r\n", "utf8"),
          Buffer.alloc(64, "m"),
          Buffer.from(`)\r\n${tag} OK done\r\n`, "utf8"),
        ]),
        expectAccept: false,
      },
      {
        uid: 15,
        body: body180,
        reportedSize: 220,
        // (e1) Valid inflated RFC822.SIZE >= 64B: exact <116> and matching 64-byte suffix
        probeWireReply: (tag) => Buffer.concat([
          Buffer.from("* 1 FETCH (UID 15 BODY[]<116> {64}\r\n", "utf8"),
          body180.subarray(116, 180),
          Buffer.from(`)\r\n${tag} OK done\r\n`, "utf8"),
        ]),
        expectAccept: true,
      },
      {
        uid: 16,
        body: body40,
        reportedSize: 80,
        // (e2) Valid inflated RFC822.SIZE < 64B: exact <0> and matching 40-byte suffix
        probeWireReply: (tag) => Buffer.concat([
          Buffer.from("* 1 FETCH (UID 16 BODY[]<0> {40}\r\n", "utf8"),
          body40,
          Buffer.from(`)\r\n${tag} OK done\r\n`, "utf8"),
        ]),
        expectAccept: true,
      },
    ];

    for (const scenario of cases) {
      const sockets = new Set<net.Socket>();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.write("* OK ready\r\n");
        let buffered = "";
        socket.on("data", chunk => {
          buffered += chunk.toString("utf8");
          for (let end = buffered.indexOf("\r\n"); end >= 0; end = buffered.indexOf("\r\n")) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const space = line.indexOf(" ");
            const tag = space < 0 ? line : line.slice(0, space);
            const rest = space < 0 ? "" : line.slice(space + 1);
            const verb = (rest.split(" ")[0] ?? "").toUpperCase();
            if (verb === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK done\r\n`);
            else if (verb === "NAMESPACE") socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
            else if (verb === "LIST") socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK done\r\n`);
            else if (verb === "EXAMINE" || verb === "SELECT") {
              socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n* OK [UIDNEXT ${scenario.uid + 1}] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
            } else if (verb === "UID" && /^FETCH\b/i.test(rest.slice(4))) {
              if (/BODY(?:\.PEEK)?\[\]<0\.26214401>/i.test(rest)) {
                socket.write(Buffer.concat([
                  Buffer.from(`* 1 FETCH (UID ${scenario.uid} RFC822.SIZE ${scenario.reportedSize} BODY[]<0> {${scenario.body.byteLength}}\r\n`, "utf8"),
                  scenario.body,
                  Buffer.from(`)\r\n${tag} OK done\r\n`, "utf8"),
                ]));
              } else if (/BODY(?:\.PEEK)?\[\]<\d+\.\d+>/i.test(rest)) {
                socket.write(scenario.probeWireReply(tag));
              } else {
                socket.write(`* 1 FETCH (UID ${scenario.uid} INTERNALDATE "02-Jan-2026 03:04:05 +0000" RFC822.SIZE ${scenario.reportedSize})\r\n${tag} OK done\r\n`);
              }
            } else if (verb === "LOGOUT") {
              socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
              socket.end();
            } else {
              socket.write(`${tag} OK done\r\n`);
            }
          }
        });
      });

      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const client = installImapCommandGuard(new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        logger: false,
        auth,
      }));
      try {
        await client.connect();
        const deps = {
          scope: { workspaceId: "workspace", ownerUserId: "owner" },
          connectionId: "connection",
          connectionVersion: 1,
          folder: "INBOX",
          cursor: null,
          since: new Date(0),
          client,
          imports: { advanceImapCursor: vi.fn() },
          storage: { upload: vi.fn(), remove: vi.fn() },
        } as unknown as ImapSyncDeps;

        if (scenario.expectAccept) {
          await expect(syncMailbox(deps)).resolves.toMatchObject({
            imported: 1,
            cursor: { folder: "INBOX", uidValidity: "42", lastUid: scenario.uid },
          });
        } else {
          await expect(syncMailbox(deps)).rejects.toThrow("IMAP message body was truncated before reaching reported size");
        }
      } finally {
        client.close();
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      }
    }
    expect(partialBodyOffsetKey(116)).toBe("BODY[]<116>");
  });

  it("aborts immediately and closes socket when a rogue server sends multiple untagged FETCH responses or exceeds command byte cap without OK", async () => {
    for (const attack of ["multi-fetch", "byte-flood"] as const) {
      let serverSawClose = false;
      const sockets = new Set<net.Socket>();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.once("close", () => {
          serverSawClose = true;
          sockets.delete(socket);
        });
        socket.on("error", () => undefined);
        socket.write("* OK ready\r\n");
        let buffered = "";
        socket.on("data", chunk => {
          buffered += chunk.toString("utf8");
          for (let end = buffered.indexOf("\r\n"); end >= 0; end = buffered.indexOf("\r\n")) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const space = line.indexOf(" ");
            const tag = space < 0 ? line : line.slice(0, space);
            const rest = space < 0 ? "" : line.slice(space + 1);
            const verb = (rest.split(" ")[0] ?? "").toUpperCase();
            if (verb === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS\r\n${tag} OK done\r\n`);
            else if (verb === "NAMESPACE") socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
            else if (verb === "LIST") socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK done\r\n`);
            else if (verb === "EXAMINE" || verb === "SELECT") {
              socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n* OK [UIDNEXT 12] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
            } else if (verb === "UID" && /^FETCH\b/i.test(rest.slice(4))) {
              if (attack === "multi-fetch") {
                // Intentionally emit two small untagged FETCH responses and omit tagged OK.
                socket.write("* 1 FETCH (UID 11 BODY[] {10}\r\n0123456789)\r\n");
                socket.write("* 1 FETCH (UID 11 BODY[] {10}\r\n0123456789)\r\n");
              } else {
                // Intentionally emit multiple small untagged padding lines > 4096B without tagged OK.
                const filler = `* OK ${"x".repeat(900)}\r\n`;
                for (let i = 0; i < 8; i += 1) {
                  socket.write(filler);
                }
              }
            } else {
              socket.write(`${tag} OK done\r\n`);
            }
          }
        });
      });

      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const client = installImapCommandGuard(
        new ImapFlow({ host: "127.0.0.1", port, secure: false, logger: false, auth }),
        { maxFetchCommandBytes: 4096 },
      );
      try {
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        await expect(
          client.fetchOne("11", { source: { start: 0, maxLength: 1024 } }, { uid: true }),
        ).rejects.toThrow(
          attack === "multi-fetch"
            ? "IMAP single-message fetch received unexpected multiple FETCH responses"
            : /exceeded 4096 bytes/,
        );
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(serverSawClose).toBe(true);
      } finally {
        client.close();
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      }
    }
  });
});
