import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import Redis from "ioredis";
import { expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import {
  advanceOpeningWorkspacePrivacyEpoch, fenceCancelledOpeningTutorStream, openingRedisConnectionOptions,
  tutorStreamAttemptHeadKey, tutorStreamKey,
} from "./opening-tutor-stream-fence";

async function withRedisServer(run: (url: string) => Promise<void>, onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run("127.0.0.1:" + (server.address() as AddressInfo).port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
}

function ioredisOptions(url: string) {
  const redis = new Redis(url, { lazyConnect: true });
  try {
    const options = {
      host: redis.options.host,
      port: redis.options.port,
      family: redis.options.family,
      path: redis.options.path,
      username: redis.options.username,
      password: redis.options.password,
      db: redis.options.db,
      tls: redis.options.tls,
    };
    return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== null));
  } finally {
    redis.disconnect();
  }
}

it.each([
  "redis://127.0.0.1:6379",
  "6380",
  "/tmp/redis.sock",
  "/run/redis/redis.sock?db=3",
  "//localhost:6380/2",
  "localhost:6380/1",
  "[::1]:6380",
  "user:pass@host:6380/2",
  "redis://localhost:6380/1",
  "rediss://cache.example.com:6380/2",
  "redis://:secret@127.0.0.1:6379/1?db=2&db=3",
  "redis://:@127.0.0.1:6379/0",
  "redis://?db=1&db=2",
  "redis://?db=1&db=2&host=a&host=b&port=6380&port=6381&family=4&family=6&path=%2Fa&path=%2Fb&username=u&username=v&password=p&password=q&tls=0&tls=1",
  "redis://127.0.0.1?tls=0",
])("matches ioredis endpoint options for %s", url => {
  expect(openingRedisConnectionOptions(url)).toEqual(ioredisOptions(url));
});

it("fails closed on an ambiguous effective database instead of fencing a different database", async () => {
  await expect(fenceCancelledOpeningTutorStream("workspace", "job", "execution", "redis://127.0.0.1?db=1&db=2"))
    .rejects.toThrow("Invalid Redis database index");
});

it.each(["http://localhost:6379", "https://localhost:6379", "postgres://localhost:5432", "unix:///tmp/redis.sock"])(
  "rejects unsupported explicit protocol %s", url => {
    expect(() => openingRedisConnectionOptions(url)).toThrow("Invalid Redis fence URL");
  },
);

it("canonicalizes workspace, job, and attempt stream key UUIDs", () => {
  expect(tutorStreamKey("  ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF  ", "  12345678-1234-4123-8123-123456789ABC  "))
    .toBe("opening:tutor-stream:abcdefab-abcd-4abc-8abc-abcdefabcdef:12345678-1234-4123-8123-123456789abc");
  expect(tutorStreamAttemptHeadKey(" ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF ", " 12345678-1234-4123-8123-123456789ABC "))
    .toBe("opening:tutor-stream:attempt-head:abcdefab-abcd-4abc-8abc-abcdefabcdef:12345678-1234-4123-8123-123456789abc");
});

it.each(["?db=3", "/?db=3", "/3?db=4"])(
  "authenticates and selects Redis DB 3 for %s before sealing, with byte-length arguments and split replies", async suffix => {
  const password = "密\r\n码";
  const auth = Buffer.from("*3\r\n$4\r\nAUTH\r\n$5\r\ntutor\r\n$8\r\n" + password + "\r\n");
  const select = Buffer.from("*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n");
  const received: Buffer[] = [];
  await withRedisServer(async address => {
    const url = "redis://tutor:" + encodeURIComponent(password) + "@" + address + suffix;
    await fenceCancelledOpeningTutorStream("workspace", "job", "execution", url);
  }, socket => {
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      const command = received.length;
      if (command === 0 && bytes.length < auth.length) return;
      if (command === 1 && bytes.length < select.length) return;
      if (command === 2 && !bytes.toString().endsWith("\r\n900\r\n")) return;
      received.push(bytes);
      bytes = Buffer.alloc(0);
      const response = command === 2 ? "$-1" : "+OK";
      socket.write(response + "\r");
      setImmediate(() => socket.write("\n"));
    });
  });
  expect(received[0]).toEqual(auth);
  expect(received[1]).toEqual(select);
  expect(received[2]?.toString()).toMatch(/^\*6\r\n\$4\r\nEVAL\r\n/);
  expect(received).toHaveLength(3);
});

it("uses ioredis query-selected port for the revocation fence", async () => {
  const received: Buffer[] = [];
  await withRedisServer(async address => {
    const port = address.slice(address.lastIndexOf(":") + 1);
    await fenceCancelledOpeningTutorStream("workspace", "job", "execution", `redis://127.0.0.1?port=${port}`);
  }, socket => {
    socket.on("data", chunk => {
      received.push(chunk);
      socket.write("$-1\r\n");
    });
  });
  expect(received).toHaveLength(1);
  expect(received[0]?.toString()).toMatch(/^\*6\r\n\$4\r\nEVAL\r\n/);
});

it.each([":", "tutor:"])("sends EVAL without AUTH for empty Redis password (%s)", async credentials => {
  const received: string[] = [];
  await withRedisServer(async address => {
    await fenceCancelledOpeningTutorStream("workspace", "job", "execution", `redis://${credentials}@${address}/0`);
  }, socket => {
    let request = "";
    socket.on("data", chunk => {
      request += chunk.toString();
      const command = /^\*\d+\r\n\$\d+\r\n([A-Z]+)\r\n/.exec(request)?.[1];
      if (!command) return;
      if (command === "EVAL" && !request.endsWith("\r\n900\r\n")) return;
      received.push(command);
      socket.write(command === "EVAL" ? "$-1\r\n" : "-ERR Client sent AUTH, but no password is set\r\n");
    });
  });
  expect(received).toEqual(["EVAL"]);
});

it("refuses an unconfirmed seal and closes the socket on a Redis error", async () => {
  let onClose!: () => void;
  const closed = new Promise<void>(resolve => { onClose = resolve; });
  await withRedisServer(async address => {
    await expect(fenceCancelledOpeningTutorStream("workspace", "job", "execution", "redis://" + address))
      .rejects.toThrow("ERR fence failed");
    await closed;
  }, socket => {
    socket.once("close", onClose);
    socket.once("data", () => socket.write("-ERR fence failed\r\n"));
  });
});

it("advanceOpeningWorkspacePrivacyEpoch skips Redis in idle workspaces and never blocks or rolls back during a Redis outage", async () => {
  const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
  let connections = 0;
  await withRedisServer(async address => {
    const makeTx = (priorExecutions: Array<{ id: string; timing_execution_id: string }>) =>
      (async (parts: TemplateStringsArray) => {
        const query = parts.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ id: scope.workspaceId, privacy_epoch: 5 }];
        if (query.startsWith("UPDATE opening_tutor_jobs j SET timing_execution_id = NULL")) return priorExecutions;
        throw new Error(`unexpected query: ${query}`);
      }) as unknown as TransactionSql;

    // Idle workspace: zero running executions => zero Redis connections even when REDIS_URL is set.
    expect(await advanceOpeningWorkspacePrivacyEpoch(makeTx([]), scope, `redis://${address}`)).toBe(5);
    expect(connections).toBe(0);

    // Active workspace with blackholed Redis: returns immediately without throwing or blocking PG commit.
    const startedAt = performance.now();
    expect(await advanceOpeningWorkspacePrivacyEpoch(
      makeTx([{ id: "00000000-0000-4000-8000-000000000003", timing_execution_id: "00000000-0000-4000-8000-000000000004" }]),
      scope, `redis://${address}`,
    )).toBe(5);
    expect(performance.now() - startedAt).toBeLessThan(500);
    await vi.waitFor(() => expect(connections).toBe(1));
  }, () => {
    // Blackhole: accept TCP and never reply.
    connections += 1;
  });
});
