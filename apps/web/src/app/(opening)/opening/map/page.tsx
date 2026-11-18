import {
  assetGraphContextSchema,
  assetGraphLensSchema,
  assetGraphNodeIdSchema,
  uuidSchema,
  type AssetGraphContext,
  type AssetGraphLens,
  type AssetGraphNodeId,
} from "@aistudy/contracts";
import { DEFAULT_ASSET_GRAPH_QUERY_ENDPOINT } from "../../../../features/opening/asset-graph/asset-graph-client";
import { AssetGraphWorkspace } from "../../../../features/opening/asset-graph/asset-graph-workspace";

function resolveContext(rawContext?: string, rawId?: string): AssetGraphContext {
  if (rawContext === "course" && rawId) {
    const direct = assetGraphContextSchema.safeParse({ kind: "course", id: rawId });
    if (direct.success) return direct.data;
    const rawUuid = uuidSchema.safeParse(rawId);
    if (rawUuid.success) return { kind: "course", id: `course/${rawUuid.data}` };
  }
  if (rawContext === "goal" && rawId) {
    const direct = assetGraphContextSchema.safeParse({ kind: "goal", id: rawId });
    if (direct.success) return direct.data;
    const rawUuid = uuidSchema.safeParse(rawId);
    if (rawUuid.success) return { kind: "goal", id: `goal/${rawUuid.data}` };
  }
  return { kind: "workspace" };
}

function resolveLens(rawLens?: string): AssetGraphLens {
  const parsed = assetGraphLensSchema.safeParse(rawLens);
  return parsed.success ? parsed.data : "all";
}

function resolveFocus(rawFocus?: string): AssetGraphNodeId | null {
  const parsed = assetGraphNodeIdSchema.safeParse(rawFocus);
  return parsed.success ? parsed.data : null;
}

export default async function OpeningMapPage({
  searchParams,
}: {
  searchParams: Promise<{ context?: string; id?: string; focus?: string; lens?: string }>;
}) {
  const params = await searchParams;
  const initialContext = resolveContext(params.context, params.id);
  const initialLens = resolveLens(params.lens);
  const initialFocus = resolveFocus(params.focus);

  return (
    <AssetGraphWorkspace
      endpoint={DEFAULT_ASSET_GRAPH_QUERY_ENDPOINT}
      initialContext={initialContext}
      initialLens={initialLens}
      initialFocus={initialFocus}
    />
  );
}
