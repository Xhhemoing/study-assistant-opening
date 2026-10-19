/**
 * PR-H: secret-free capabilities protocol. Client-safe (no registry, no secrets).
 * The browser decides what to SHOW only from this response; the server decides
 * what to ALLOW on every request from its own switches.
 */
import { z } from "zod";
import { CAPABILITIES_PROTOCOL_VERSION } from "./build-config.mjs";

export { CAPABILITIES_PROTOCOL_VERSION } from "./build-config.mjs";

export const openingCapabilitiesSchema = z.object({
  /** Teaching loop: api = server routes answer for this user; ui = show the loop/workspace UI. */
  teachingLoop: z.object({ api: z.boolean(), ui: z.boolean() }).strict(),
  /** UI-only behavior; no API behind it. */
  matrixTransformInteractive: z.boolean(),
  /** UI-only: jingwei 图解 under chat answers (rules planner over the answer text). */
  chatArtifacts: z.boolean(),
  /** UI-only: render answers as Markdown + math (LearningProse) instead of plain text. */
  chatProse: z.boolean(),
  /** Self-registration; /api/auth/register re-checks the same switch. */
  registrationOpen: z.boolean(),
  /** Learning-signal daily drafts, autonomy modes and suggested tasks; routes re-check. */
  adaptivePlanning: z.boolean(),
  /** Model-assisted re-planning (L7); requires adaptivePlanning. */
  planAgent: z.boolean(),
  systemQuery: z.boolean().default(false),
}).strict();

export const openingCapabilitiesResponseSchema = z.object({
  protocolVersion: z.literal(CAPABILITIES_PROTOCOL_VERSION),
  buildConfigDigest: z.string().min(1),
  authenticated: z.boolean(),
  capabilities: openingCapabilitiesSchema,
}).strict();

export type OpeningCapabilities = z.infer<typeof openingCapabilitiesSchema>;
export type OpeningCapabilitiesResponse = z.infer<typeof openingCapabilitiesResponseSchema>;

/** Fail-closed default before (or instead of) a valid server response. */
export const CLOSED_CAPABILITIES: OpeningCapabilities = {
  teachingLoop: { api: false, ui: false },
  matrixTransformInteractive: false,
  chatArtifacts: false,
  chatProse: false,
  registrationOpen: false,
  adaptivePlanning: false,
  planAgent: false,
  systemQuery: false,
};

/**
 * Client-side acceptance of a capabilities response. A protocol or build digest
 * mismatch (stale bundle against a different backend) yields closed capabilities.
 */
export function acceptCapabilitiesResponse(
  raw: unknown,
  compiledDigest: string | undefined,
): { capabilities: OpeningCapabilities; compatible: boolean; reason?: string } {
  const parsed = openingCapabilitiesResponseSchema.safeParse(raw);
  if (!parsed.success) return { capabilities: CLOSED_CAPABILITIES, compatible: false, reason: "invalid capabilities response" };
  if (!compiledDigest || parsed.data.buildConfigDigest !== compiledDigest) {
    return { capabilities: CLOSED_CAPABILITIES, compatible: false, reason: "build config digest mismatch" };
  }
  return { capabilities: parsed.data.capabilities, compatible: true };
}
