import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { isOpeningProviderBaseUrl } from "@aistudy/contracts";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export class OpeningProviderEndpointError extends Error {
  constructor(message = "provider endpoint is not allowed") { super(message); this.name = "OpeningProviderEndpointError"; }
}

export function isPublicProviderAddress(address: string): boolean {
  if (isIP(address) === 4) return !blockedV4.check(address, "ipv4");
  // Only global unicast is eligible. This excludes ULA, link-local, multicast,
  // mapped IPv4 and translation prefixes, including their private IPv4 targets.
  return isIP(address) === 6 && publicV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

function isLoopback(address: string): boolean {
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

export function openingProviderAllowsLocal(): boolean {
  const value = process.env.OPENING_PROVIDER_ALLOW_LOCAL?.trim().toLowerCase();
  return process.env.NODE_ENV !== "production" && value !== undefined && ["1", "true", "yes"].includes(value);
}

export function assertOpeningProviderEndpoint(value: string): URL {
  if (!isOpeningProviderBaseUrl(value, { allowLocal: openingProviderAllowsLocal() })) throw new OpeningProviderEndpointError();
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = openingProviderAllowsLocal() && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if ((isIP(hostname) && !(local ? isLoopback(hostname) : isPublicProviderAddress(hostname)))
      || (!local && (hostname === "localhost" || hostname.endsWith(".localhost")))) throw new OpeningProviderEndpointError();
  return url;
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

/** The checked address is returned directly to the socket's own lookup callback.
 * There is no second resolver/fetch call after validation, including on reconnect.
 */
export function providerConnectionLookup(local: boolean, resolve: Resolve = hostname => dnsLookup(hostname, { all: true })): LookupFunction {
  return (hostname, _options, callback) => {
    void resolve(hostname).then(addresses => {
      if (addresses.length === 0 || addresses.some(({ address, family }) =>
        isIP(address) !== family || !(local ? isLoopback(address) : isPublicProviderAddress(address)))) {
        callback(new OpeningProviderEndpointError(), "", 0);
        return;
      }
      const chosen = addresses.find(address => address.family === 4) ?? addresses[0]!;
      callback(null, chosen.address, chosen.family);
    }, error => callback(error instanceof Error ? error : new Error("provider DNS lookup failed"), "", 0));
  };
}

/** Node's HTTP transport never follows redirects. Socket lookup validates and pins
 * DNS results; the original hostname stays in Host, SNI and certificate checks.
 * An injected fetch is a test seam, never selected by runtime configuration.
 */
export async function fetchOpeningProvider(value: string, init: RequestInit): Promise<Response> {
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new OpeningProviderEndpointError("provider request body must be JSON text");
  const url = assertOpeningProviderEndpoint(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = openingProviderAllowsLocal() && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  return new Promise((resolve, reject) => {
    const options = {
      method: init.method, headers: Object.fromEntries(headers), signal: init.signal ?? undefined,
      agent: false as const, autoSelectFamily: false, lookup: providerConnectionLookup(local),
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status > 599) {
        response.destroy();
        reject(new OpeningProviderEndpointError("provider returned an invalid HTTP status"));
        return;
      }
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new OpeningProviderEndpointError("provider redirects are not allowed"));
        return;
      }
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        let bytes = 0, closed = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Buffer) => {
              if (closed) return;
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                closed = true;
                const error = new OpeningProviderEndpointError("provider response is too large");
                controller.error(error); request.destroy(error); return;
              }
              controller.enqueue(chunk);
              if ((controller.desiredSize ?? 0) <= 0) response.pause();
            });
            response.on("error", error => { if (!closed) { closed = true; controller.error(error); } });
            response.on("end", () => { if (!closed) { closed = true; controller.close(); } });
          },
          pull() { response.resume(); },
          cancel() { closed = true; response.destroy(); request.destroy(); },
        });
        if (status === 204 || status === 205) { void body.cancel(); }
        resolve(new Response(status === 204 || status === 205 ? null : body, { status, headers: responseHeaders }));
      } catch {
        response.destroy();
        reject(new OpeningProviderEndpointError("provider returned an invalid HTTP response"));
      }
    });
    request.on("error", reject);
    request.end(init.body as string | undefined);
  });
}
