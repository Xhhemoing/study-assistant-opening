/**
 * Fail-soft block decisions: one bad block is skipped with a reason, the rest of the
 * artifact still renders. Never throws on untrusted params.
 */
import type { Artifact, ArtifactBlock } from "./artifact";
import type { Capability, CapabilityRegistry, DisplayMode } from "./capability";
import { findUnsafeContent, type UnsafeContentKind } from "./sanitize";
import { resolveDisplayMode, type ViewPrefs } from "./view";

export type BlockFailReason =
  | "unknown_capability"
  | "unsafe_link"
  | "unsafe_markup"
  | "unsafe_handler"
  | "params_too_deep"
  | "illegal_action"
  | "invalid_params";

export type BlockDecision =
  | {
      ok: true;
      blockId: string;
      capability: Capability;
      params: unknown;
      mode: DisplayMode;
      /** Always available: text mode body, export, and the boundary fallback. */
      text: string;
    }
  | { ok: false; blockId: string; reason: BlockFailReason; detail?: string };

const UNSAFE_REASON: Record<UnsafeContentKind, BlockFailReason> = {
  link: "unsafe_link",
  markup: "unsafe_markup",
  handler: "unsafe_handler",
  depth: "params_too_deep",
};

export function decideBlock(
  block: ArtifactBlock,
  registry: CapabilityRegistry,
  prefs: ViewPrefs = {},
): BlockDecision {
  const capability = registry.get(block.capability);
  if (!capability) return { ok: false, blockId: block.id, reason: "unknown_capability" };

  const unsafe = findUnsafeContent(block.params);
  if (unsafe) return { ok: false, blockId: block.id, reason: UNSAFE_REASON[unsafe.kind], detail: unsafe.path };

  const declared = new Set(capability.actions ?? []);
  const undeclared = block.allowedActions.find((action) => !declared.has(action));
  if (undeclared) return { ok: false, blockId: block.id, reason: "illegal_action", detail: undeclared };

  const parsed = capability.params.safeParse(block.params);
  if (!parsed.success) {
    return {
      ok: false,
      blockId: block.id,
      reason: "invalid_params",
      detail: parsed.error.issues[0]?.message,
    };
  }

  return {
    ok: true,
    blockId: block.id,
    capability,
    params: parsed.data,
    mode: resolveDisplayMode(capability.modes, prefs),
    text: capability.toText(parsed.data),
  };
}

export function decideArtifact(artifact: Artifact, registry: CapabilityRegistry, prefs: ViewPrefs = {}): BlockDecision[] {
  return artifact.blocks.map((block) => decideBlock(block, registry, prefs));
}

/** Prose rendering of a whole artifact (terminals, exports, other agents). Skipped blocks are named, not hidden. */
export function artifactToText(artifact: Artifact, registry: CapabilityRegistry): string {
  const parts = artifact.title ? [artifact.title] : [];
  for (const [index, decision] of decideArtifact(artifact, registry, { textOnly: true }).entries()) {
    const limits = artifact.blocks[index]!.limits;
    if (!decision.ok) {
      parts.push(`[已跳过一块内容：${decision.reason}]`);
      continue;
    }
    parts.push(limits.length ? `${decision.text}\n（${limits.join("；")}）` : decision.text);
  }
  return parts.join("\n\n");
}
