import { readFile } from "node:fs/promises";
import { createSourceVisualRecognitionInput, parseSourceVisualRecognitionOutput, isBudgetReplayError, type ModelGateway } from "@aistudy/ai";
import type { OpeningModelSnapshot, ProviderInput, Scope } from "@aistudy/contracts";
import type { createOpeningSourceVisualRecognitionsRepository, SourceVisualRecord } from "@aistudy/database";
import type { ParseSourceVisualPageInput, ParseSourceVisualPageResult } from "../jobs/parse-source";
import { MAX_PDF_RENDER_PAGES, renderPdfPageImages } from "../parsers/pdf-page-images";

type Repository = ReturnType<typeof createOpeningSourceVisualRecognitionsRepository>;
type CallOptions = Parameters<ModelGateway["call"]>[2];

async function callVisual(deps: { repository: Repository; gateway: Pick<ModelGateway, "call"> }, scope: Scope, options: CallOptions) {
  const base = options.operationId;
  const budget = { ...options.budget, reserve: async (input: Parameters<CallOptions["budget"]["reserve"]>[0]) => {
    const state = await deps.repository.ledger(scope, base);
    if (state !== "unsent") throw Object.assign(new Error("资料识别已有发送或费用记录，请查看原请求状态；不会重复发送。"), { code: "SOURCE_VISUAL_OUTCOME_PENDING" });
    return await deps.repository.releasedReservation(scope, input) ?? options.budget.reserve(input);
  } };
  let operationId = base;
  const visited = new Set<string>();
  while (true) {
    try { return await deps.gateway.call(scope, "materials.recognize-page", { ...options, budget, operationId }); }
    catch (error) {
      if (!isBudgetReplayError(error) || error.disposition.kind !== "released"
        || !["not_sent", "cancelled"].includes(error.disposition.reason ?? "") || visited.has(error.disposition.reservationId)) throw error;
      visited.add(error.disposition.reservationId);
      operationId = `${base}:retry:${error.disposition.reservationId}`;
    }
  }
}

function readableResult(record: SourceVisualRecord): ParseSourceVisualPageResult {
  const { transcription, description, uncertainties } = record.result;
  return { imageObjectKey: record.imageObjectKey, text: [
    transcription ? `【原图忠实转写，尚需核对】\n${transcription}` : "",
    description ? `【图表观察描述，非原文或解答】\n${description}` : "",
    uncertainties.length ? `【识别不确定，不能据此判定正确】\n${uncertainties.join("\n")}` : "",
  ].filter(Boolean).join("\n\n") };
}

/** One durable paid operation per source revision and physical page, across job retries. */
export function createSourceVisualRecognition(deps: {
  repository: Repository; gateway: Pick<ModelGateway, "call">;
  budget(scope: Scope): CallOptions["budget"];
  storage: { finalKey(id: string, version: number): string };
  renderPdf?: typeof renderPdfPageImages;
}) {
  const renderPdf = deps.renderPdf ?? renderPdfPageImages;

  async function readCached({ scope, signal, sourceId, sourceVersion, physicalPage }: ParseSourceVisualPageInput) {
    signal.throwIfAborted();
    const cached = await deps.repository.read(scope, { sourceId, sourceVersion, physicalPage });
    signal.throwIfAborted();
    return cached;
  }

  async function recognize(input: ParseSourceVisualPageInput, imageParts: ProviderInput["imageParts"]) {
    const { scope, signal, sourceId, sourceVersion, physicalPage } = input;
    const identity = { sourceId, sourceVersion, physicalPage };
    signal.throwIfAborted();
    const operationId = `source-visual:v1:${scope.workspaceId}:${sourceId}:${sourceVersion}:${physicalPage}`;
    // Keep the original object plus its physical page. PDF images are rendered
    // by the authorized source loader, without unmanaged duplicate PNG objects.
    const imageObjectKey = deps.storage.finalKey(sourceId, sourceVersion);
    let modelSnapshot: OpeningModelSnapshot | undefined;
    let saved: SourceVisualRecord | undefined;
    try {
      await callVisual(deps, scope, {
        budget: deps.budget(scope), operationId, resultRef: operationId, signal,
        parentBudget: { id: `source-visual:v1:${scope.workspaceId}:${sourceId}:${sourceVersion}`, maxProviderCalls: 2000 },
        input: createSourceVisualRecognitionInput({ ...identity, nativeText: input.nativeText, imageParts }),
        onModel: model => { modelSnapshot = model.modelSnapshot; },
        beforeSend: async () => { signal.throwIfAborted(); await deps.repository.assertCurrent(scope, identity); },
        persistResult: async output => {
          if (!modelSnapshot) throw new Error("visual recognition model attribution missing");
          const record = { result: parseSourceVisualRecognitionOutput(output.text), modelSnapshot, operationId, imageObjectKey };
          await deps.repository.save(scope, identity, record, signal);
          saved = record;
        },
      });
    } catch (error) {
      // Completed concurrent execution may already have persisted its page.
      // Unknown, released and in-flight ledgers are never bypassed or re-sent.
      if (!isBudgetReplayError(error) || error.disposition.kind !== "completed") throw error;
      const replay = await deps.repository.read(scope, identity);
      if (!replay) throw error;
      saved = replay;
    }
    signal.throwIfAborted();
    await deps.repository.assertCurrent(scope, identity);
    if (!saved) throw new Error("visual recognition returned without a durable page result");
    return readableResult(saved);
  }

  async function recognizePage(input: ParseSourceVisualPageInput) {
    const cached = await readCached(input);
    if (cached) return readableResult(cached);
    const { sourceId, physicalPage, signal } = input;
    const bytes = await readFile(input.localFilePath);
    signal.throwIfAborted();
    const imageParts = input.mime === "application/pdf"
      ? await renderPdf(bytes, [{ sourceId, physicalPage }])
      : [{ sourceId, physicalPage, mediaType: input.mime as "image/jpeg" | "image/png" | "image/webp",
        data: `data:${input.mime};base64,${bytes.toString("base64")}` }];
    return recognize(input, imageParts);
  }

  async function* recognizePages(inputs: readonly ParseSourceVisualPageInput[]) {
    for (let start = 0; start < inputs.length; start += MAX_PDF_RENDER_PAGES) {
      const batch = inputs.slice(start, start + MAX_PDF_RENDER_PAGES);
      const { localFilePath, signal } = batch[0]!;
      const entries = [];
      for (const input of batch) entries.push({ input, cached: await readCached(input) });
      const requests = entries.flatMap(({ input: { sourceId, physicalPage }, cached }) => cached ? [] : [{ sourceId, physicalPage }]);
      const bytes = requests.length ? await readFile(localFilePath) : undefined;
      signal.throwIfAborted();
      let images: Awaited<ReturnType<typeof renderPdf>> | undefined;
      if (bytes) {
        try {
          images = await renderPdf(bytes, requests);
        } catch (error) {
          signal.throwIfAborted();
          if (requests.length === 1) throw error;
          // A later page can break batch rendering. Render individually in order
          // in that case so earlier pages can still save their durable results.
        }
      }
      let nextImage = 0;
      for (const { input, cached } of entries) {
        signal.throwIfAborted();
        if (cached) {
          yield readableResult(cached);
        } else {
          const index = nextImage++;
          const imageParts = images ? [images[index]!] : await renderPdf(bytes!, [requests[index]!]);
          yield await recognize(input, imageParts);
        }
      }
    }
  }

  return { recognizePage, recognizePages };
}
