/**
 * Opening's jingwei host: one capability registry + renderer map for every surface
 * (chat, teaching, notes). Teaching-only gating stays in teaching/component-catalog.ts.
 */
import { STANDARD_CAPABILITIES, createCapabilityRegistry, planFromRules, type Artifact } from "@aistudy/jingwei";
import { STANDARD_RENDERERS, type RendererMap } from "@aistudy/jingwei/react";
import { matrixTransformCapability, teachingRenderers } from "./teaching/teaching-capabilities";

export const openingCapabilities = createCapabilityRegistry([...STANDARD_CAPABILITIES, matrixTransformCapability]);
export const openingRenderers: RendererMap = { ...STANDARD_RENDERERS, ...teachingRenderers };

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
