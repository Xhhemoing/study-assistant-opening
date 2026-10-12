"use client";

import type { ComponentType, ErrorInfo, ReactNode } from "react";
import type { Artifact, ArtifactBlock } from "../artifact";
import type { CapabilityRegistry, DisplayMode } from "../capability";
import { decideBlock, type BlockDecision, type BlockFailReason } from "../decide";
import type { ViewPrefs } from "../view";
import { RenderBoundary } from "./render-boundary";

export type RendererProps<P = unknown> = {
  blockId: string;
  params: P;
  /** "static" or "interactive"; text mode never reaches a renderer. */
  mode: Exclude<DisplayMode, "text">;
  prefs: ViewPrefs;
};

/** Host-supplied React renderers keyed by capability id. Capabilities stay framework-free. */
export type RendererMap = Readonly<Record<string, ComponentType<RendererProps>>>;

export function defineRenderer<P>(renderer: ComponentType<RendererProps<P>>): ComponentType<RendererProps> {
  return renderer as unknown as ComponentType<RendererProps>;
}

export const BLOCK_FAIL_LABELS: Record<BlockFailReason, string> = {
  unknown_capability: "暂不支持这种表达，已跳过该块",
  unsafe_link: "含有不安全链接，已跳过该块",
  unsafe_markup: "含有不受支持的标记，已跳过该块",
  unsafe_handler: "含有未授权脚本，已跳过该块",
  params_too_deep: "内容结构过深，已跳过该块",
  illegal_action: "含有未授权动作，已跳过该块",
  invalid_params: "内容参数不完整，已跳过该块（不补造数值）",
};

type Failed = Extract<BlockDecision, { ok: false }>;

export type BlockViewProps = {
  block: ArtifactBlock;
  registry: CapabilityRegistry;
  renderers: RendererMap;
  prefs?: ViewPrefs;
  /** Usually the artifact revision; a new value retries a crashed renderer. */
  resetKey?: string | number;
  /** Hosts may keep their own fail-soft copy; defaults to BLOCK_FAIL_LABELS. */
  renderSkipped?: (decision: Failed) => ReactNode;
  onRenderError?: (blockId: string, error: unknown, info: ErrorInfo) => void;
};

function SkippedBlock({ decision }: { decision: Failed }) {
  return (
    <div
      className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-5 text-zinc-600 ring-1 ring-zinc-900/5"
      role="status"
      data-jingwei-skipped={decision.reason}
      data-block-id={decision.blockId}
    >
      {BLOCK_FAIL_LABELS[decision.reason]}
    </div>
  );
}

function TextBody({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{text}</p>;
}

export function BlockView({
  block,
  registry,
  renderers,
  prefs = {},
  resetKey = 0,
  renderSkipped,
  onRenderError,
}: BlockViewProps) {
  const decision = decideBlock(block, registry, prefs);
  if (!decision.ok) return <>{renderSkipped ? renderSkipped(decision) : <SkippedBlock decision={decision} />}</>;

  const Renderer = renderers[decision.capability.id];
  const mode = decision.mode;
  return (
    <section className="space-y-1.5" data-jingwei-block={block.id} data-jingwei-capability={decision.capability.id} data-jingwei-mode={Renderer ? mode : "text"}>
      {mode === "text" || !Renderer ? (
        <TextBody text={decision.text} />
      ) : (
        <RenderBoundary
          fallbackText={decision.text}
          resetKey={resetKey}
          onError={onRenderError ? (error, info) => onRenderError(block.id, error, info) : undefined}
        >
          <Renderer blockId={block.id} params={decision.params} mode={mode} prefs={prefs} />
        </RenderBoundary>
      )}
      {block.limits.length ? (
        <ul className="space-y-0.5 text-[11px] leading-5 text-zinc-500" aria-label="解读边界">
          {block.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export type ArtifactViewProps = Omit<BlockViewProps, "block" | "resetKey"> & { artifact: Artifact };

export function ArtifactView({ artifact, ...rest }: ArtifactViewProps) {
  return (
    <article className="space-y-4" data-jingwei-artifact={artifact.artifactId} data-jingwei-revision={artifact.revision}>
      {artifact.title ? <h3 className="text-sm font-semibold text-zinc-950">{artifact.title}</h3> : null}
      {artifact.blocks.map((block) => (
        <BlockView key={block.id} block={block} resetKey={artifact.revision} {...rest} />
      ))}
    </article>
  );
}
