import { createServer, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "./provider";
import {
  assertOpeningProviderEndpoint, fetchOpeningProvider, isPublicProviderAddress,
  OpeningProviderEndpointError, providerConnectionLookup,
} from "./provider-network";

afterEach(() => vi.unstubAllEnvs());

const input = { instruction: "answer", text: "hello", chunks: [], mode: "hint" as const,
  maxOutputTokens: 100, mediaCapability: "text_only" as const, imageParts: [] };

async function listening(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function lookup(resolve: (hostname: string) => Promise<LookupAddress[]>, local = false) {
  return new Promise<{ address: string; family: number }>((accept, reject) => {
    providerConnectionLookup(local, resolve)("provider.example", {}, (error, address, family) => {
      if (error) reject(error); else accept({ address: address as string, family: family as number });
    });
  });
}

describe("provider outbound boundary", () => {
  it.each(["0.0.0.0", "10.1.1.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.31.0.1", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.19.1.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:a00:1::",
    "2001::1", "2001:db8::1", "3fff::1"])("blocks non-public address %s", address => {
    expect(isPublicProviderAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("permits public address %s", address => {
    expect(isPublicProviderAddress(address)).toBe(true);
  });

  it("rejects mixed public/private DNS answers and revalidates every connection", async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(lookup(resolve)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(lookup(resolve)).rejects.toBeInstanceOf(OpeningProviderEndpointError);
    await expect(lookup(async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]))
      .rejects.toBeInstanceOf(OpeningProviderEndpointError);
    await expect(lookup(async () => [])).rejects.toBeInstanceOf(OpeningProviderEndpointError);
    await expect(lookup(async () => [{ address: "8.8.8.8", family: 6 }])).rejects.toBeInstanceOf(OpeningProviderEndpointError);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("returns only a checked address to the socket and does not resolve again", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "2606:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }]);
    expect(await lookup(resolve)).toEqual({ address: "1.1.1.1", family: 4 });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("provider.example");
  });

  it("requires explicit local development mode and ignores it in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "0");
    expect(() => assertOpeningProviderEndpoint("http://127.0.0.1:8000")).toThrow(OpeningProviderEndpointError);
    vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    expect(assertOpeningProviderEndpoint("http://[::1]:8000").hostname).toBe("[::1]");
    expect(() => assertOpeningProviderEndpoint("https://192.168.1.1")).toThrow(OpeningProviderEndpointError);
    vi.stubEnv("NODE_ENV", "production");
    for (const url of ["http://localhost:8000", "https://localhost", "https://127.1", "https://2130706433", "https://[::1]", "https://[::ffff:127.0.0.1]"]) {
      expect(() => assertOpeningProviderEndpoint(url)).toThrow(OpeningProviderEndpointError);
    }
  });

  it("uses the real guarded transport for an explicitly enabled local model", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    const observed: { authorization?: string; url?: string; body?: string } = {};
    const server = createServer((request, response) => {
      observed.authorization = request.headers.authorization; observed.url = request.url;
      let body = ""; request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        observed.body = body;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "verified", citedChunkIds: [], candidates: [] }) } }] }));
      });
    });
    const url = await listening(server);
    try {
      const result = await createOpeningProvider({ baseUrl: `${url.replace("127.0.0.1", "localhost")}/v1`, apiKey: "local-test-key", model: "local" }).complete(input);
      expect(result.text).toBe("verified");
      expect(observed).toMatchObject({ authorization: "Bearer local-test-key", url: "/v1/chat/completions" });
      expect(JSON.parse(observed.body!).model).toBe("local");
    } finally { await close(server); }
  });

  it.each([301, 302, 303, 304, 307, 308])("refuses HTTP %i without contacting the redirect destination", async status => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    let destinations = 0;
    const server = createServer((request, response) => {
      if (request.url === "/stolen") destinations++;
      response.writeHead(status, { location: "/stolen" }); response.end();
    });
    const url = await listening(server);
    try {
      await expect(createOpeningProvider({ baseUrl: url, apiKey: "must-not-redirect", model: "local" }).complete(input))
        .rejects.toMatchObject({ code: "PROVIDER_ENDPOINT", retryable: false });
      expect(destinations).toBe(0);
    } finally { await close(server); }
  });

  it("aborts a real pending request and bounds response size", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/large")) response.end(Buffer.alloc(8 * 1024 * 1024 + 1));
      // The other endpoint deliberately never responds.
    });
    const url = await listening(server);
    try {
      await expect(createOpeningProvider({ baseUrl: url, apiKey: "key", model: "local", timeoutMs: 25 }).complete(input))
        .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
      const caller = new AbortController();
      const pending = createOpeningProvider({ baseUrl: url, apiKey: "key", model: "local" }).complete(input, caller.signal);
      caller.abort();
      await expect(pending).rejects.toMatchObject({ code: "PROVIDER_ABORTED", retryable: false });
      await expect(fetchOpeningProvider(`${url}/large`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(OpeningProviderEndpointError);
    } finally { await close(server); }
  });

  it("rejects an out-of-range status without throwing outside the promise", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    const server = createServer((_request, response) => { response.writeHead(700); response.end("invalid"); });
    const url = await listening(server);
    try {
      await expect(fetchOpeningProvider(url, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(OpeningProviderEndpointError);
    } finally { await close(server); }
  });
});
