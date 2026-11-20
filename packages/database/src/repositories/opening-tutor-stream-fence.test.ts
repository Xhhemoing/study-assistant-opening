import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { expect, it } from "vitest";
import { fenceCancelledOpeningTutorStream } from "./opening-tutor-stream-fence";

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

it("authenticates and selects the Redis DB before sealing, with byte-length arguments and split replies", async () => {
  const password = "密\r\n码";
  const auth = Buffer.from("*3\r\n$4\r\nAUTH\r\n$5\r\ntutor\r\n$8\r\n" + password + "\r\n");
  const select = Buffer.from("*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n");
  const received: Buffer[] = [];
  await withRedisServer(async address => {
    const url = "redis://tutor:" + encodeURIComponent(password) + "@" + address + "/3";
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
