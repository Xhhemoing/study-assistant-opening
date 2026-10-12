/**
 * PR-H: server-side view of the typed configuration. Switches are re-read per
 * request from the server environment; the browser never decides access.
 */
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";
import {
  CAPABILITIES_PROTOCOL_VERSION,
  computeBuildConfigDigest,
  type OpeningCapabilities,
  type OpeningCapabilitiesResponse,
} from "@aistudy/config/public";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function openingCapabilitiesFor(userId: string | null, env: Env = process.env): OpeningCapabilities {
  return resolveCapabilities(loadFeatureSwitches(env), userId);
}

export function openingCapabilitiesResponse(userId: string | null, env: Env = process.env): OpeningCapabilitiesResponse {
  return {
    protocolVersion: CAPABILITIES_PROTOCOL_VERSION,
    buildConfigDigest: computeBuildConfigDigest(env),
    authenticated: userId !== null,
    capabilities: openingCapabilitiesFor(userId, env),
  };
}

/**
 * Teaching-loop API gate. Returns a 404 response when the loop API is not
 * enabled for this user (off, or outside the rollout), else null. Hidden UI is
 * never the only protection.
 */
export function teachingLoopApiDenied(userId: string, env: Env = process.env): Response | null {
  if (openingCapabilitiesFor(userId, env).teachingLoop.api) return null;
  const response = Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
