import type { Server, Socket } from "node:net";
import { createServer } from "node:net";

export type OpeningImapMail = {
  uid: number;
  internalDate?: Date;
  source: string;
  advertisedSize?: number;
  omitSize?: boolean;
};

const IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatImapInternalDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = IMAP_MONTHS[date.getUTCMonth()] ?? "Jan";
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}-${month}-${year} ${hh}:${mm}:${ss} +0000`;
}

export type OpeningImapServer = {
  port: number;
  mails: OpeningImapMail[];
  close(): Promise<void>;
  logoutCount(): number;
  activeConnectionCount(): number;
  waitForConnectionsClosed(): Promise<void>;
};

/**
 * Minimal standard IMAP4rev1 server used only by the isolated Opening sync
 * gate. It exercises the real ImapFlow protocol stack and real MailParser
 * through wire-compatible LIST/EXAMINE/FETCH/LOGOUT exchanges.
 */
export async function startOpeningImapServer(inputMails: OpeningImapMail[]): Promise<OpeningImapServer> {
  // Reply in fixture order while keeping sequence numbers in mailbox order.
  const mails = [...inputMails];
  let logoutCount = 0;

  const sockets = new Map<Socket, Promise<void>>();
  const server: Server = createServer((socket) => {
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      });
    });
    sockets.set(socket, closed);
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
          const isUidFetch = verb === "UID";
          const fetchArgs = isUidFetch ? args.replace(/^FETCH\s+/i, "") : args;
          // ImapFlow uses FETCH / UID FETCH with ranges like 1:* and quoted or parenthesized items.
          const match = /^(\d+)(?::(\d+|\*))?\s+(?:\((.*)\)|(\S+))\s*$/i.exec(fetchArgs);
          if (!match) {
            tagged(tag, "BAD FETCH syntax");
            return;
          }
          const start = Number(match[1]);
          const end = match[2] === "*" ? Number.MAX_SAFE_INTEGER : match[2] ? Number(match[2]) : start;
          const fields = match[3] ?? match[4] ?? "";
          const sequenceByUid = new Map([...mails].sort((a, b) => a.uid - b.uid)
            .map((mail, index) => [mail.uid, index + 1]));
          for (const mail of mails) {
            const sequence = sequenceByUid.get(mail.uid)!;
            const selector = isUidFetch ? mail.uid : sequence;
            if (selector < start || selector > end) continue;
            const date = formatImapInternalDate(mail.internalDate ?? new Date("2026-01-02T03:04:05.000Z"));
            const rawSource = Buffer.from(mail.source, "utf8");
            const advertisedSize = mail.advertisedSize ?? rawSource.byteLength;
            const metadataParts: string[] = [];
            if (isUidFetch || /\bUID\b/i.test(fields)) {
              metadataParts.push(`UID ${mail.uid}`);
            }
            if (/\bINTERNALDATE\b/i.test(fields)) {
              metadataParts.push(`INTERNALDATE "${date}"`);
            }
            if (/\bRFC822\.SIZE\b/i.test(fields) && !mail.omitSize) {
              metadataParts.push(`RFC822.SIZE ${advertisedSize}`);
            }
            const partialMatch = /BODY(?:\.PEEK)?\[\]<(\d+)(?:\.(\d+))?>/i.exec(fields);
            if (partialMatch) {
              const startByte = Number(partialMatch[1]);
              const maxLength = partialMatch[2] !== undefined ? Number(partialMatch[2]) : undefined;
              const sliceStart = Math.min(startByte, rawSource.byteLength);
              const sliceEnd = maxLength !== undefined
                ? Math.min(sliceStart + maxLength, rawSource.byteLength)
                : rawSource.byteLength;
              const slice = rawSource.subarray(sliceStart, sliceEnd);
              const prefix = [...metadataParts, `BODY[]<${startByte}> {${slice.byteLength}}`].join(" ");
              socket.write(Buffer.concat([
                Buffer.from(`* ${sequence} FETCH (${prefix}\r\n`, "utf8"),
                slice,
                Buffer.from(")\r\n", "utf8"),
              ]));
            } else if (/BODY(?:\.PEEK)?\[\](?!<)/i.test(fields)) {
              const prefix = [...metadataParts, `BODY[] {${rawSource.byteLength}}`].join(" ");
              socket.write(Buffer.concat([
                Buffer.from(`* ${sequence} FETCH (${prefix}\r\n`, "utf8"),
                rawSource,
                Buffer.from(")\r\n", "utf8"),
              ]));
            } else {
              send(`* ${sequence} FETCH (${metadataParts.join(" ")})`);
            }
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
      for (const socket of sockets.keys()) {
        socket.destroy();
      }
      await Promise.all(sockets.values());
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
    logoutCount: () => logoutCount,
    activeConnectionCount: () => sockets.size,
    waitForConnectionsClosed: async () => {
      await Promise.all(sockets.values());
    },
  };
}
