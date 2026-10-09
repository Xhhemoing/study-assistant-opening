import type { Server, Socket } from "node:net";
import { createServer } from "node:net";

export type OpeningImapMail = {
  uid: number;
  internalDate?: Date;
  source: string;
};

export type OpeningImapServer = {
  port: number;
  mails: OpeningImapMail[];
  close(): Promise<void>;
  logoutCount(): number;
};

/**
 * Minimal standard IMAP4rev1 server used only by the isolated Opening sync
 * gate. It exercises the real ImapFlow protocol stack and real MailParser
 * through wire-compatible LIST/EXAMINE/FETCH/LOGOUT exchanges.
 */
export async function startOpeningImapServer(inputMails: OpeningImapMail[]): Promise<OpeningImapServer> {
  const mails = [...inputMails].sort((a, b) => a.uid - b.uid);
  let logoutCount = 0;

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    const send = (line: string) => socket.write(`${line}\r\n`);
    const tagged = (tag: string, text = "OK done") => send(`${tag} ${text}`);
    send("* OK Opening IMAP fixture ready");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const spaceIndex = line.indexOf(" ");
        const tag = spaceIndex < 0 ? line : line.slice(0, spaceIndex);
        const rest = spaceIndex < 0 ? "" : line.slice(spaceIndex + 1);
        // ImapFlow sends "LOGIN \"user\" \"pass\"" — match the verb, not the whole rest.
        const verbMatch = /^(\S+)(?:\s+(.*))?$/.exec(rest);
        const verb = (verbMatch?.[1] ?? "").toUpperCase();
        const args = verbMatch?.[2] ?? "";
        if (verb === "CAPABILITY") {
          send("* CAPABILITY IMAP4rev1 UIDPLUS");
          tagged(tag, "OK CAPABILITY completed");
        } else if (verb === "LOGIN") {
          tagged(tag, "OK LOGIN completed");
        } else if (verb === "NAMESPACE") {
          send(`* NAMESPACE (("" "/")) NIL NIL`);
          tagged(tag, "OK NAMESPACE completed");
        } else if (verb === "LIST") {
          send(`* LIST () "/" "INBOX"`);
          tagged(tag, "OK LIST completed");
        } else if (verb === "LSUB") {
          send(`* LSUB () "/" "INBOX"`);
          tagged(tag, "OK LSUB completed");
        } else if (verb === "EXAMINE" || verb === "SELECT") {
          send(`* ${mails.length} EXISTS`);
          send(`* 0 RECENT`);
          send(`* OK [UIDVALIDITY 42] UIDs valid`);
          send(`* OK [UIDNEXT ${Math.max(...mails.map(mail => mail.uid), 0) + 1}] next uid`);
          send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);
          send(`* OK [PERMANENTFLAGS ()] read-only`);
          tagged(tag, "OK [READ-ONLY] EXAMINE completed");
        } else if (verb === "FETCH" || (verb === "UID" && /^FETCH\b/i.test(args))) {
          const fetchArgs = verb === "UID" ? args.replace(/^FETCH\s+/i, "") : args;
          // ImapFlow uses UID FETCH with ranges like 1:* and quoted atoms.
          const match = /^(\d+)(?::(\d+|\*))?\s+\((.*)\)\s*$/i.exec(fetchArgs);
          if (!match) {
            tagged(tag, "BAD FETCH syntax");
            return;
          }
          const start = Number(match[1]);
          const end = match[2] === "*" ? Number.MAX_SAFE_INTEGER : match[2] ? Number(match[2]) : start;
          for (const mail of mails) {
            if (mail.uid < start || mail.uid > end) continue;
            const sequence = mails.indexOf(mail) + 1;
            const date = (mail.internalDate ?? new Date("2026-01-02T03:04:05.000Z")).toUTCString().replace("GMT", "+0000");
            send(
              `* ${sequence} FETCH (UID ${mail.uid} INTERNALDATE "${date}" BODY[] {${Buffer.byteLength(mail.source)}}\r\n` +
              mail.source +
              `)`,
            );
          }
          tagged(tag, "OK FETCH completed");
        } else if (verb === "LOGOUT") {
          send(`* BYE Opening IMAP fixture closing`);
          tagged(tag, "OK LOGOUT completed");
          logoutCount += 1;
          socket.end();
        } else {
          tagged(tag, "BAD unknown command");
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture IMAP server did not expose a loopback port");

  return {
    port: address.port,
    mails,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    logoutCount: () => logoutCount,
  };
}