/**
 * Opening's jingwei host: one capability registry + renderer map for every surface
 * (chat, teaching, notes). Teaching-only gating stays in teaching/component-catalog.ts.
 */
import { STANDARD_CAPABILITIES, createCapabilityRegistry, planFromRules, type Artifact } from "@aistudy/jingwei";
import { STANDARD_RENDERERS, type RendererMap } from "@aistudy/jingwei/react";
import { matrixTransformCapability, teachingRenderers } from "./teaching/teaching-capabilities";

export const openingCapabilities = createCapabilityRegistry([...STANDARD_CAPABILITIES, matrixTransformCapability]);
export const openingRenderers: RendererMap = { ...STANDARD_RENDERERS, ...teachingRenderers };

/**
 * Default off until browser acceptance. Client bundles may only see NEXT_PUBLIC_*.
 * Same shape as the other opening flags (teaching-loop-flag.ts).
 */
export function isChatArtifactsEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.OPENING_CHAT_ARTIFACTS ?? env.NEXT_PUBLIC_OPENING_CHAT_ARTIFACTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export type MessageArtifact = { artifact: Artifact; reason: string };

/**
 * Rules-derived artifacts are a pure function of the answer text, so they are
 * computed on read instead of stored: nothing extra to back up, redact or mask
 * when a memory or source is deleted (the text already is).
 */
export function artifactsForMessages(
  messages: ReadonlyArray<{ id: string; role: "user" | "assistant"; text: string; status?: string }>,
): Record<string, MessageArtifact> {
  const result: Record<string, MessageArtifact> = {};
  let question: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      question = message.text;
      continue;
    }
    if (message.status && message.status !== "complete") continue;
    const { artifact, reason } = planFromRules({ question, answer: message.text, artifactId: `turn-${message.id}` });
    if (artifact) result[message.id] = { artifact, reason };
  }
  return result;
}
