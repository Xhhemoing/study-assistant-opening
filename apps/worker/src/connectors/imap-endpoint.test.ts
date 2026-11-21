import net, { type AddressInfo, type NetConnectOpts } from "node:net";
import tls from "node:tls";
import { ImapFlow } from "imapflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApprovedImapClient,
  MAX_IMAP_LINE_BYTES,
  MAX_IMAP_LITERAL_BYTES,
  MAX_IMAP_RESPONSE_BYTES,
} from "./imap-endpoint";
import { runWithSyncDeadline } from "./imap-sync";

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

  it("configures bounded line, literal, and response size limits on ImapFlow", async () => {
    const client = await createApprovedImapClient(endpoint, auth, publicAnswers);
    expect(client.options.maxLineLength).toBe(MAX_IMAP_LINE_BYTES);
    expect(client.options.maxLiteralSize).toBe(MAX_IMAP_LITERAL_BYTES);
    expect(client.options.maxResponseSize).toBe(MAX_IMAP_RESPONSE_BYTES);
    expect(MAX_IMAP_LITERAL_BYTES).toBeGreaterThan(25 * 1024 * 1024);
    expect(MAX_IMAP_LITERAL_BYTES).toBeLessThan(64 * 1024 * 1024);
    expect(MAX_IMAP_RESPONSE_BYTES).toBeGreaterThan(MAX_IMAP_LITERAL_BYTES);
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

  it("parses 1-byte EOF and non-EOF partial fetchOne responses on ImapFlow via BODY.PEEK[]<start.1>", async () => {
    const partialQueries: string[] = [];
    const payload = Buffer.from("Subject: Probe\r\n\r\n" + "x".repeat(162), "utf8");
    expect(payload.byteLength).toBe(180);

    const server = net.createServer(socket => {
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
          else if (verb === "LOGIN") socket.write(`${tag} OK done\r\n`);
          else if (verb === "NAMESPACE") socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
          else if (verb === "LIST") socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK done\r\n`);
          else if (verb === "EXAMINE" || verb === "SELECT") {
            socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n* OK [UIDNEXT 12] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
          } else if (verb === "UID" && /^FETCH\b/i.test(rest.slice(4))) {
            const match = /BODY(?:\.PEEK)?\[\]<(\d+)\.(\d+)>/i.exec(rest);
            if (match) {
              partialQueries.push(match[0]);
              const start = Number(match[1]);
              const maxLen = Number(match[2]);
              const slice = payload.subarray(start, start + maxLen);
              socket.write(Buffer.concat([
                Buffer.from(`* 1 FETCH (UID 11 BODY[]<${start}> {${slice.byteLength}}\r\n`, "utf8"),
                slice,
                Buffer.from(")\r\n", "utf8"),
              ]));
            }
            socket.write(`${tag} OK done\r\n`);
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
    const client = new ImapFlow({
      host: "127.0.0.1",
      port,
      secure: false,
      logger: false,
      auth,
    });
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      const eofProbe = await client.fetchOne("11", { source: { start: 180, maxLength: 1 } }, { uid: true });
      expect(eofProbe).toBeTruthy();
      if (eofProbe) {
        expect(eofProbe.uid).toBe(11);
        expect(Buffer.isBuffer(eofProbe.source)).toBe(true);
        expect(eofProbe.source?.byteLength).toBe(0);
      }

      const moreProbe = await client.fetchOne("11", { source: { start: 179, maxLength: 1 } }, { uid: true });
      expect(moreProbe).toBeTruthy();
      if (moreProbe) {
        expect(moreProbe.uid).toBe(11);
        expect(Buffer.isBuffer(moreProbe.source)).toBe(true);
        expect(moreProbe.source?.toString("utf8")).toBe("x");
      }
      expect(partialQueries).toEqual(["BODY.PEEK[]<180.1>", "BODY.PEEK[]<179.1>"]);
      await client.logout();
    } finally {
      client.close();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  });
});
