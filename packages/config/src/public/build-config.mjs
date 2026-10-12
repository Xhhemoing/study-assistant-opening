// PR-H: build-config digest. Plain JS so next.config.mjs can import it at build time.
// Covers every NEXT_PUBLIC_* present at build (none are allowed today) and the
// capabilities protocol version. Pure, isomorphic (no node:crypto): FNV-1a 64.

export const CAPABILITIES_PROTOCOL_VERSION = 1;

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Digest of the public build surface: protocol version + sorted NEXT_PUBLIC_* name=value. */
export function computeBuildConfigDigest(env) {
  const publicEntries = Object.keys(env)
    .filter((name) => name.startsWith("NEXT_PUBLIC_"))
    .sort()
    .map((name) => `${name}=${env[name] ?? ""}`);
  return `v${CAPABILITIES_PROTOCOL_VERSION}-${fnv1a64(JSON.stringify(publicEntries))}`;
}
