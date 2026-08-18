import {
  markdownExportRequestSchema,
  type LossEntry,
  type MarkdownExportResponse,
} from "@aistudy/contracts";
import { exportMarkdownBundle, libraryDocumentToPortable } from "@aistudy/domain";
import type { Principal } from "../../lib/authorization";
import {
  getDocumentForPrincipal,
  listDocumentsForPrincipal,
  type AuthRuntime,
} from "../auth/service";

export async function exportMarkdownForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<MarkdownExportResponse> {
  const parsed = markdownExportRequestSchema.parse(body ?? {});
  const documents = parsed.documentId
    ? [await getDocumentForPrincipal(runtime, principal, parsed.documentId)]
    : await listDocumentsForPrincipal(runtime, principal);

  const extras: LossEntry[] = [];
  const portable = await Promise.all(documents.map(async (document) => {
    const [properties, relations] = await Promise.all([
      runtime.library.listProperties({
        workspaceId: principal.workspaceId,
        subjectType: "document",
        subjectId: document.id,
      }),
      runtime.library.listRelations({
        workspaceId: principal.workspaceId,
        subjectType: "document",
        subjectId: document.id,
      }),
    ]);
    extras.push(...documentLosses(document.id, properties, relations.length));
    return libraryDocumentToPortable({
      id: document.id,
      title: document.title,
      tags: tagsFrom(properties),
      blocks: document.blocks,
    });
  }));

  const exported = exportMarkdownBundle(portable);
  return {
    format: "markdown",
    markdown: exported.markdown,
    manifest: exported.manifest,
    lossReport: {
      claimedLossless: false,
      losses: [...exported.lossReport.losses, ...extras],
    },
  };
}

function tagsFrom(properties: Array<{ key: string; valueType: string; value: unknown }>): string[] {
  const property = properties.find((item) => item.key === "tags");
  if (!property || property.valueType !== "json" || !Array.isArray(property.value)) return [];
  return property.value.filter((tag): tag is string => typeof tag === "string");
}

function documentLosses(
  documentId: string,
  properties: Array<{ key: string }>,
  relationCount: number,
): LossEntry[] {
  const losses: LossEntry[] = [];
  if (relationCount > 0) {
    losses.push({
      code: "relations",
      feature: "relations",
      message: "Document relations are omitted from Markdown.",
      documentId,
    });
  }
  if (properties.some((property) => property.key !== "tags")) {
    losses.push({
      code: "custom-properties",
      feature: "properties",
      message: "Custom properties other than tags are omitted from Markdown.",
      documentId,
    });
  }
  return losses;
}
