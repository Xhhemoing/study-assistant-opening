"use client";

import type { ReactNode } from "react";
import type { ActivitySpecClientInit, TeachingSourceRef } from "@aistudy/contracts";
import {
  decideBlockRender,
  failSoftReasonLabel,
  type CatalogId,
  type ClientInitBlock,
  type FailSoftReason,
} from "./component-catalog";
import { BlockView } from "@aistudy/jingwei/react";
import { MatrixTransformBlock } from "./blocks/matrix-transform";
import { useOpeningCapabilities } from "../capabilities/capabilities-provider";
import { LearningProse } from "../assistant/learning-prose";
import { InlineAttempt, type InlineAttemptContext } from "./inline-attempt";
import { ProblemCard } from "./problem-card";
import {
  MATRIX_TRANSFORM_CAPABILITY_ID,
  teachingArtifactBlock,
  teachingCapabilities,
  teachingRenderers,
} from "./teaching-capabilities";

/** PR-H: interactivity is a server capability (UI-only switch), not a client env read. */
function CapabilityMatrixTransformBlock({ blockId, content }: { blockId: string; content: Record<string, unknown> }) {
  const { matrixTransformInteractive } = useOpeningCapabilities();
  return (
    <BlockView
      block={teachingArtifactBlock(blockId, MATRIX_TRANSFORM_CAPABILITY_ID, content)}
      registry={teachingCapabilities}
      renderers={teachingRenderers}
      prefs={{ preferredMode: matrixTransformInteractive ? "interactive" : "static" }}
      // Keep the block's own parse-fail card (lists the errors, never invents numbers).
      renderSkipped={() => <MatrixTransformBlock content={content} interactive={false} />}
    />
  );
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(asText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.markdown === "string") return rec.markdown;
    if (typeof rec.prompt === "string") return rec.prompt;
    if (typeof rec.latex === "string") return rec.latex;
    if (typeof rec.formula === "string") return rec.formula;
    if (typeof rec.label === "string") return rec.label;
  }
  return "";
}

function asSteps(params: Record<string, unknown>): string[] {
  const steps = params.steps;
  if (Array.isArray(steps)) {
    return steps.map(asText).filter(Boolean);
  }
  const text = asText(params.text);
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, "").trim())
    .filter(Boolean);
}

function FailSoftCard({ reason, blockId }: { reason: FailSoftReason; blockId: string }) {
  return (
    <div
      className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-5 text-zinc-600 ring-1 ring-zinc-900/5"
      role="status"
      data-block-fail-soft={reason}
      data-block-id={blockId}
    >
      {failSoftReasonLabel(reason)}
    </div>
  );
}

function CatalogBody({
  catalogId,
  params,
  sourceRefs,
  attemptContext,
}: {
  catalogId: CatalogId;
  params: Record<string, unknown>;
  sourceRefs?: TeachingSourceRef[];
  attemptContext?: InlineAttemptContext;
}): ReactNode {
  const text = asText(params.text) || asText(params);
  switch (catalogId) {
    case "text":
      return (
        <div className="text-sm leading-6 text-zinc-800" data-catalog="text">
          {text ? <LearningProse text={text} /> : "（空文本块）"}
        </div>
      );
    case "math": {
      const math =
        asText(params.latex) || asText(params.formula) || asText(params.text) || text;
      return (
        <div
          className="rounded-lg bg-zinc-50 px-3 py-2 font-mono text-sm leading-6 text-zinc-900 ring-1 ring-zinc-900/5"
          data-catalog="math"
        >
          <span className="sr-only">公式：</span>
          {math ? <LearningProse text={/^\s*\$/.test(math) ? math : `$$\n${math}\n$$`} /> : <code>（空公式）</code>}
        </div>
      );
    }
    case "step": {
      const steps = asSteps(params);
      if (!steps.length) {
        return (
          <p className="text-sm text-zinc-600" data-catalog="step">
            （暂无步骤）
          </p>
        );
      }
      return (
        <ol
          className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-zinc-800"
          data-catalog="step"
        >
          {steps.map((step, i) => (
            <li key={i}><LearningProse text={step} /></li>
          ))}
        </ol>
      );
    }
    case "example":
      return (
        <aside
          className="rounded-lg border border-emerald-200/80 bg-emerald-50/40 px-3 py-2 text-sm leading-6 text-zinc-800"
          data-catalog="example"
        >
          <p className="mb-1 text-[11px] font-medium text-emerald-800">例题 / 示例</p>
          {text ? <LearningProse text={text} /> : <p>（空示例）</p>}
        </aside>
      );
    case "question":
      return (
        <ProblemCard prompt={text || "（空提问）"}>
          {attemptContext ? <InlineAttempt blockId={String(params.blockId)} prompt={text} context={attemptContext} /> : <p className="text-xs text-text-2">请从教学工作区打开本题以保存作答。</p>}
        </ProblemCard>
      );
    case "draft":
      return (
        <div
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-6 text-zinc-700"
          data-catalog="draft"
        >
          <p className="mb-1 text-[11px] font-medium text-zinc-600">个人草稿</p>
          <p className="whitespace-pre-wrap text-zinc-600">
            {text || "草稿锚点已预留；保存需服务端 draft-anchors 接口。"}
          </p>
        </div>
      );
    case "evidence": {
      const refs = sourceRefs ?? [];
      if (!refs.length && !text) {
        return (
          <p className="text-[11px] text-zinc-500" data-catalog="evidence">
            暂无引用材料
          </p>
        );
      }
      return (
        <ul className="space-y-1.5 text-xs leading-5 text-zinc-700" data-catalog="evidence">
          {text ? <li className="whitespace-pre-wrap">{text}</li> : null}
          {refs.map((ref, i) => (
            <li
              key={`${ref.sourceId}-${i}`}
              className="rounded-md bg-zinc-50 px-2 py-1.5 ring-1 ring-zinc-900/5"
            >
              <span className="font-medium text-zinc-800">来源 </span>
              <span className="tabular-nums text-zinc-600">{ref.sourceId.slice(0, 8)}…</span>
              {ref.page != null ? (
                <span className="ml-2 text-zinc-500">p.{ref.page}</span>
              ) : null}
              {ref.chunkId ? (
                <span className="ml-2 text-zinc-500">
                  chunk {String(ref.chunkId).slice(0, 8)}…
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    case "matrix_transform": {
      // Strip chrome keys that decideBlockRender injects; domain parse wants MathModel fields only.
      const {
        blockId,
        position: _position,
        role: _role,
        blockType: _blockType,
        ...mathContent
      } = params;
      return (
        <CapabilityMatrixTransformBlock blockId={String(blockId)} content={mathContent} />
      );
    }
    default:
      return null;
  }
}

export function BlockRenderer({
  block,
  schemaVersion,
  sourceRefs,
  attemptContext,
}: {
  block: ClientInitBlock;
  schemaVersion?: string | null;
  sourceRefs?: TeachingSourceRef[];
  attemptContext?: InlineAttemptContext;
}) {
  const decision = decideBlockRender(block, { schemaVersion });
  if (!decision.ok) {
    return <FailSoftCard reason={decision.reason} blockId={block.blockId} />;
  }
  return (
    <article
      className="space-y-1"
      data-teaching-block={block.blockId}
      data-catalog-id={decision.catalogId}
    >
      <CatalogBody
        catalogId={decision.catalogId}
        params={decision.params}
        sourceRefs={decision.catalogId === "evidence" ? sourceRefs : undefined}
        attemptContext={attemptContext}
      />
    </article>
  );
}

/** Scan renderer module contract for tests (C9): no model HTML injection API. */
export const BLOCK_RENDERER_FORBIDS_RAW_HTML = true as const;

export function renderClientInitBlocks(
  clientInit: Pick<ActivitySpecClientInit, "blocks" | "generationConfig" | "sourceRefs">,
  schemaVersion: string | null,
): { blockId: string; ok: boolean; catalogId?: CatalogId; reason?: FailSoftReason }[] {
  return clientInit.blocks.map((block) => {
    const d = decideBlockRender(block, { schemaVersion });
    if (!d.ok) return { blockId: block.blockId, ok: false, reason: d.reason };
    return { blockId: block.blockId, ok: true, catalogId: d.catalogId };
  });
}
