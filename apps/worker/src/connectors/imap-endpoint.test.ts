import net, { type AddressInfo, type NetConnectOpts } from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovedImapClient } from "./imap-endpoint";

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
});
