/**
 * V2-08 teaching compiler — propose editable outline, compile current activity.
 * Reuses V2-06 assembleTeachingEvidencePack / formatProviderContext (no forked chunk loader).
 * Sync structure helpers; worker keeps budgeted provider fences.
 */
import { randomUUID } from "node:crypto";
import type {
  ActivitySpecPublishInput,
  SourceChunk,
  TeachingBlockRef,
  TeachingGoal,
  TeachingSourceRef,
} from "@aistudy/contracts";
import {
  assertOutlineHonest,
  normalizeBlockTypes,
  suggestPrerequisites,
  type TeachingOutline,
  type TeachingOutlineItem,
} from "@aistudy/domain";
import {
  assembleTeachingEvidencePack,
  assertNoHeldOutLeak,
  formatProviderContext,
  type TeachingEvidenceDenylist,
  type TeachingEvidencePack,
} from "./teaching-evidence";

export type ProposeOutlineInput = {
  activityId: string;
  intentSummary: string;
  intentKind: string;
  sourceIds: string[];
  chunks: SourceChunk[];
  currentPage?: number | null;
  existingOutline?: TeachingOutline;
  maxItems?: number;
  teachingUnitId?: string;
  outlineId?: string;
};

export type CompileCurrentInput = {
  outline: TeachingOutline;
  focusItemId: string;
  pack: TeachingEvidencePack;
  teachingUnitId: string;
  expectedContentVersion: number;
  revisionNumber: number;
  prefetchNext?: boolean;
  /** Optional stable block-id factory (tests). */
  newBlockId?: () => string;
};

export type CompileLibraryBlock = {
  id: string;
  type: string;
  content: Record<string, unknown>;
  role: "teach" | "prompt" | "example" | "answer_key" | "meta";
};

export type CompileCurrentResult = {
  publishInput: ActivitySpecPublishInput;
  libraryBlocks: CompileLibraryBlock[];
  outlineUsed: TeachingOutline;
  prefetchSkeleton?: TeachingOutlineItem | null;
  providerMeta?: { usedModel: boolean; stub: false };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function roleForBlockType(
  blockType: string,
): CompileLibraryBlock["role"] {
  switch (blockType) {
    case "prompt":
      return "prompt";
    case "example":
      return "example";
    case "answer_key":
      return "answer_key";
    case "meta":
      return "meta";
    default:
      return "teach";
  }
}

function notesForIntent(intentKind: string, intentSummary: string): string {
  const summary = intentSummary.toLowerCase();
  if (
    intentKind === "topic" ||
    /\btopic[\s-]?only\b/i.test(intentSummary)
  ) {
    return "Topic-only path: outline from topic intent; sources optional.";
  }
  if (
    /already know|skimming|速览|已会/i.test(intentSummary) ||
    summary.includes("skim")
  ) {
    return "Skimming path: learner reports prior knowledge — keep light, skippable depth.";
  }
  if (/no.?foundation|无基础|零基础/i.test(intentSummary)) {
    return "No-foundation path: start from basics; prerequisites suggested but skippable.";
  }
  if (/conflict|目标冲突/i.test(intentSummary)) {
    return "Conflict-goals path: surface competing goals in notes; no mastery lock.";
  }
  if (intentKind === "question") {
    return "Question-driven path: focus on the asked question with evidence anchors.";
  }
  if (intentKind === "material" || intentKind === "goal") {
    return "Material/goal path: compile from authorized sources and stated goals.";
  }
  return "Intent path: small-scope outline before compiling the current activity.";
}

function normalizeExistingOutline(outline: TeachingOutline): TeachingOutline {
  const items = outline.items.map((item) => ({
    ...item,
    intendedBlockTypes: normalizeBlockTypes(item.intendedBlockTypes ?? []),
  }));
  const next: TeachingOutline = {
    ...outline,
    kind: "teaching_path",
    items,
    prereqs: suggestPrerequisites({ ...outline, items, prereqs: outline.prereqs ?? [] }),
  };
  assertOutlineHonest(next);
  return next;
}

/**
 * Propose an editable teaching outline.
 * If existingOutline is provided → validate/normalize only (no silent overwrite of user edits).
 */
export function proposeTeachingOutline(input: ProposeOutlineInput): TeachingOutline {
  if (input.existingOutline) {
    return normalizeExistingOutline({
      ...input.existingOutline,
      activityId: input.existingOutline.activityId || input.activityId,
      teachingUnitId: input.existingOutline.teachingUnitId ?? input.teachingUnitId,
    });
  }

  const maxItems = Math.min(Math.max(input.maxItems ?? 6, 1), 8);
  const note = notesForIntent(input.intentKind, input.intentSummary);
  const sourceIds = [...input.sourceIds];
  const pageHint =
    input.currentPage == null
      ? " (no current page — still using authorized sources when present)"
      : ` (page ${input.currentPage})`;

  const items: TeachingOutlineItem[] = [];
  const titles = buildItemTitles(input.intentSummary, maxItems);
  for (let i = 0; i < titles.length; i++) {
    const itemId = `item-${String(i + 1).padStart(2, "0")}`;
    const blockTypes =
      i === 0
        ? ["text", "prompt"]
        : i === titles.length - 1
          ? ["prompt", "example", "text"]
          : ["text", "formula", "example"];
    items.push({
      itemId,
      title: titles[i]!,
      goalIds: [`goal-${i + 1}`],
      intendedBlockTypes: normalizeBlockTypes(blockTypes),
      sourceIds: [...sourceIds],
      prereqItemIds: i > 0 ? [items[i - 1]!.itemId] : undefined,
      notes: i === 0 ? `${note}${pageHint}` : undefined,
    });
  }

  const outline: TeachingOutline = {
    outlineId: input.outlineId ?? `outline-${input.activityId}`,
    activityId: input.activityId,
    teachingUnitId: input.teachingUnitId,
    focusItemId: items[0]!.itemId,
    items,
    prereqs: [],
    kind: "teaching_path",
  };
  outline.prereqs = suggestPrerequisites(outline);
  assertOutlineHonest(outline);
  return outline;
}

function buildItemTitles(intentSummary: string, maxItems: number): string[] {
  const trimmed = intentSummary.trim();
  const base = trimmed.length > 0 ? trimmed.slice(0, 80) : "Teaching focus";
  const titles = [
    `Hook: ${base}`,
    "Observe & relate",
    "Define core idea",
    "Worked example",
    "Check understanding",
    "Optional practice",
    "Wrap-up",
    "Extension",
  ];
  return titles.slice(0, maxItems);
}

function goalsFromItem(item: TeachingOutlineItem): TeachingGoal[] {
  return item.goalIds.map((goalId) => ({
    goalId,
    statement: item.notes?.trim() || item.title,
    linkedSourceIds: item.sourceIds.filter(isUuid).slice(0, 32),
  }));
}

function sourceRefsFromPack(
  pack: TeachingEvidencePack,
  item: TeachingOutlineItem,
): TeachingSourceRef[] {
  const allowed = new Set(item.sourceIds);
  const refs: TeachingSourceRef[] = [];
  const seen = new Set<string>();
  for (const anchor of pack.anchors) {
    if (!isUuid(anchor.sourceId)) continue;
    if (allowed.size > 0 && !allowed.has(anchor.sourceId)) continue;
    const key = `${anchor.sourceId}:${anchor.chunkId ?? ""}:${anchor.page ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      sourceId: anchor.sourceId,
      version: anchor.sourceVersion,
      chunkId: anchor.chunkId,
      page: anchor.page,
    });
  }
  if (refs.length === 0) {
    for (const sourceId of item.sourceIds) {
      if (!isUuid(sourceId)) continue;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      refs.push({ sourceId });
    }
  }
  return refs.slice(0, 64);
}

function buildBlocksForItem(
  item: TeachingOutlineItem,
  pack: TeachingEvidencePack,
  newBlockId: () => string,
): CompileLibraryBlock[] {
  const types = normalizeBlockTypes(item.intendedBlockTypes);
  const evidenceSnippet = pack.chunks[0]?.text?.slice(0, 400) ?? "";
  const blocks: CompileLibraryBlock[] = [];

  for (const blockType of types) {
    const role = roleForBlockType(blockType);
    const id = newBlockId();
    if (role === "answer_key") {
      blocks.push({
        id,
        type: blockType,
        role,
        content: {
          // Server-side only; never projected to client init while hidden.
          answer: `Key points for ${item.title}`,
          hidden: true,
        },
      });
      continue;
    }
    if (role === "prompt") {
      blocks.push({
        id,
        type: blockType,
        role,
        content: {
          text: `Prompt: reflect on “${item.title}”.`,
        },
      });
      continue;
    }
    if (role === "example") {
      blocks.push({
        id,
        type: blockType,
        role,
        content: {
          text: evidenceSnippet
            ? `Example drawn from authorized material: ${evidenceSnippet}`
            : `Example for “${item.title}” (no materials — generated_example).`,
        },
      });
      continue;
    }
    blocks.push({
      id,
      type: blockType,
      role,
      content: {
        text:
          blockType === "formula"
            ? `Formula notes for “${item.title}”.`
            : evidenceSnippet
              ? `${item.title}: ${evidenceSnippet}`
              : `${item.title}: presentable teaching block from outline${item.notes ? ` — ${item.notes}` : ""}.`,
      },
    });
  }

  // Guarantee at least one presentable teach block.
  if (blocks.length === 0) {
    blocks.push({
      id: newBlockId(),
      type: "text",
      role: "teach",
      content: { text: item.title },
    });
  }
  return blocks;
}

/**
 * Compile the current (focus) outline item into publish graph + library drafts.
 * Prefetch at most one next skeleton when enabled. Does not wait for whole course.
 */
export function compileCurrentActivity(input: CompileCurrentInput): CompileCurrentResult {
  const outline = normalizeExistingOutline(input.outline);
  const focusItemId = input.focusItemId || outline.focusItemId;
  const focus = outline.items.find((i) => i.itemId === focusItemId);
  if (!focus) {
    throw new Error(`focus item ${focusItemId} not found in outline`);
  }

  // Held-out / privacy: compiler respects pack boundaries.
  assertNoHeldOutLeak({
    packSourceIds: input.pack.anchors.map((a) => a.sourceId),
    packChunkIds: input.pack.chunks.map((c) => c.id),
    denylist: {
      sourceIds: input.pack.boundaries.privacyExcludedSourceIds,
    },
  });

  const newBlockId = input.newBlockId ?? (() => randomUUID());
  const libraryBlocks = buildBlocksForItem(focus, input.pack, newBlockId);
  const blockOrder: TeachingBlockRef[] = libraryBlocks.map((b, position) => ({
    blockId: b.id,
    position,
    blockType: b.type,
    role: b.role,
  }));

  if (blockOrder.length === 0) {
    throw new Error("compileCurrentActivity produced empty blockOrder");
  }

  const publishInput: ActivitySpecPublishInput = {
    activityId: outline.activityId,
    teachingUnitId: input.teachingUnitId,
    expectedVersion: input.expectedContentVersion,
    revisionNumber: input.revisionNumber,
    blockOrder,
    sourceRefs: sourceRefsFromPack(input.pack, focus),
    goals: goalsFromItem(focus),
    verificationStatus: "needs_check",
    generationConfig: {
      extras: {
        outlineId: outline.outlineId,
        focusItemId,
        compiler: "teaching-compiler",
        // intentionally no stub: true
      },
    },
  };

  let prefetchSkeleton: TeachingOutlineItem | null = null;
  if (input.prefetchNext) {
    const idx = outline.items.findIndex((i) => i.itemId === focusItemId);
    if (idx >= 0 && idx + 1 < outline.items.length) {
      prefetchSkeleton = { ...outline.items[idx + 1]! };
    }
  }

  return {
    publishInput,
    libraryBlocks,
    outlineUsed: { ...outline, focusItemId },
    prefetchSkeleton,
    providerMeta: { usedModel: false, stub: false },
  };
}

export function buildCompileProviderInput(
  outline: TeachingOutline,
  pack: TeachingEvidencePack,
): { instruction: string; text: string } {
  const focus =
    outline.items.find((i) => i.itemId === outline.focusItemId) ?? outline.items[0];
  const context = formatProviderContext(pack.chunks);
  return {
    instruction:
      "Compile the current teaching activity from the editable outline and authorized UNTRUSTED evidence only. " +
      "Do not invent sources. Do not emit mastery percentages. Prefer small-scope presentable blocks.",
    text: [
      `outlineId=${outline.outlineId}`,
      `focusItemId=${outline.focusItemId}`,
      `focusTitle=${focus?.title ?? ""}`,
      `goalIds=${(focus?.goalIds ?? []).join(",")}`,
      "--- OUTLINE JSON ---",
      JSON.stringify({
        outlineId: outline.outlineId,
        focusItemId: outline.focusItemId,
        items: outline.items.map((i) => ({
          itemId: i.itemId,
          title: i.title,
          goalIds: i.goalIds,
          intendedBlockTypes: i.intendedBlockTypes,
          sourceIds: i.sourceIds,
          notes: i.notes,
        })),
      }),
      "--- EVIDENCE (UNTRUSTED) ---",
      context,
    ].join("\n"),
  };
}

/** Client-safe projection: answer_key plaintext must not leak while hidden. */
export function projectClientSafeLibraryBlocks(
  blocks: CompileLibraryBlock[],
): Array<{
  blockId: string;
  blockType: string;
  role: CompileLibraryBlock["role"];
  content: Record<string, unknown> | null;
}> {
  return blocks.map((b) => ({
    blockId: b.id,
    blockType: b.type,
    role: b.role,
    content:
      b.role === "answer_key" && b.content.hidden !== false
        ? null
        : { ...b.content },
  }));
}

export type BuildCompilerPublishInputOptions = {
  loadChunks?: (
    scope: unknown,
    sourceIds: string[],
  ) => Promise<SourceChunk[]>;
  /** Outline already edited by user / stored in extras. */
  readOutline?: () => TeachingOutline | null | undefined;
  writeLibraryBlocks?: (blocks: CompileLibraryBlock[]) => Promise<void>;
  intentSummary?: string;
  intentKind?: string;
  currentPage?: number | null;
  prefetchNext?: boolean;
  maxItems?: number;
  denylist?: TeachingEvidenceDenylist;
  privacyExcludedSourceIds?: string[];
  newBlockId?: () => string;
};

/**
 * Factory for worker `buildPublishInput` — outline → evidence → compile current.
 */
export function createCompilerBuildPublishInput(
  options: BuildCompilerPublishInputOptions = {},
) {
  return async function buildPublishInput(
    _scope: unknown,
    payload: {
      activityId: string;
      teachingUnitId?: string;
      expectedContentVersion: number;
      expectedUnitVersion?: number;
      sourceIds?: string[];
      mode?: string;
    },
    providerOutput: { text?: string } | null,
  ): Promise<ActivitySpecPublishInput> {
    const teachingUnitId = payload.teachingUnitId;
    if (!teachingUnitId) {
      throw new Error("compiler buildPublishInput requires teachingUnitId");
    }
    const sourceIds = payload.sourceIds ?? [];
    const chunks = options.loadChunks ? await options.loadChunks(_scope, sourceIds) : [];

    let outline = options.readOutline?.() ?? null;
    if (!outline && providerOutput?.text) {
      try {
        const parsed = JSON.parse(providerOutput.text) as {
          outline?: TeachingOutline;
        };
        if (parsed?.outline?.kind === "teaching_path") {
          outline = parsed.outline;
        }
      } catch {
        // provider text is not outline JSON — propose below
      }
    }

    const proposed = proposeTeachingOutline({
      activityId: payload.activityId,
      intentSummary:
        options.intentSummary ??
        (typeof providerOutput?.text === "string" && providerOutput.text.length > 0
          ? providerOutput.text.slice(0, 500)
          : `Compile teaching for activity ${payload.activityId}`),
      intentKind: options.intentKind ?? "material",
      sourceIds,
      chunks,
      currentPage: options.currentPage ?? null,
      existingOutline: outline ?? undefined,
      maxItems: options.maxItems,
      teachingUnitId,
    });

    assertOutlineHonest(proposed);

    const pack = assembleTeachingEvidencePack({
      chunks,
      query: proposed.items.find((i) => i.itemId === proposed.focusItemId)?.title ?? proposed.focusItemId,
      maxCharacters: 6000,
      preferPage:
        options.currentPage == null ? undefined : options.currentPage,
      allowlistSourceIds: sourceIds.length > 0 ? sourceIds : undefined,
      denylist: options.denylist,
      privacyExcludedSourceIds: options.privacyExcludedSourceIds,
    });

    const revisionNumber =
      typeof payload.expectedUnitVersion === "number" &&
      payload.expectedUnitVersion > 0
        ? payload.expectedUnitVersion
        : 1;

    const compiled = compileCurrentActivity({
      outline: proposed,
      focusItemId: proposed.focusItemId,
      pack,
      teachingUnitId,
      expectedContentVersion: payload.expectedContentVersion,
      revisionNumber,
      prefetchNext: options.prefetchNext === true,
      newBlockId: options.newBlockId,
    });

    if (options.writeLibraryBlocks) {
      await options.writeLibraryBlocks(compiled.libraryBlocks);
    }

    if (compiled.publishInput.blockOrder.length === 0) {
      throw new Error("compiler publishInput.blockOrder must be non-empty");
    }
    const extras = compiled.publishInput.generationConfig?.extras ?? {};
    if ("stub" in extras) {
      throw new Error("compiler publishInput must not set extras.stub");
    }
    return compiled.publishInput;
  };
}

/** Env flag: teachingCompiler.enabled */
export function isTeachingCompilerEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw =
    env.OPENING_TEACHING_COMPILER_ENABLED ??
    env.TEACHING_COMPILER_ENABLED ??
    "";
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}
