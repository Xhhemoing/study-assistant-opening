import {
  dayAdjustmentPostInputSchema,
  dayAdjustmentPreviewInputSchema,
} from "@aistudy/contracts";
import { ApiError, jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createOpeningDayAdjustmentService } from "../../../../../features/opening/server/day-adjustment-service";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const;

const ALLOWED_GET_KEYS = new Set([
  "date",
  "targetDate",
  "moveTaskIds",
  "removeTaskIds",
  "quickTaskId",
  "quickStartAt",
  "targetStartAt",
]);

function withPrivateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function readCsvList(params: URLSearchParams, key: string): string[] | undefined {
  const all = params.getAll(key);
  if (all.length === 0) return undefined;
  return all
    .flatMap((entry) => entry.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePreviewSearchParams(request: Request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_GET_KEYS.has(key)) {
      throw new ApiError("VALIDATION", `unsupported query parameter: ${key}`, 400);
    }
  }
  const date = url.searchParams.get("date") ?? undefined;
  const rawTargetDate = url.searchParams.get("targetDate");
  const targetDate = rawTargetDate === null ? undefined : rawTargetDate === "" ? null : rawTargetDate;
  const rawQuickTaskId = url.searchParams.get("quickTaskId");
  const quickTaskId = rawQuickTaskId === null ? undefined : rawQuickTaskId === "" ? null : rawQuickTaskId;
  const quickStartAt = url.searchParams.get("quickStartAt") ?? undefined;
  const targetStartAt = url.searchParams.get("targetStartAt") ?? undefined;
  const moveTaskIds = readCsvList(url.searchParams, "moveTaskIds");
  const removeTaskIds = readCsvList(url.searchParams, "removeTaskIds");

  return dayAdjustmentPreviewInputSchema.parse({
    ...(date !== undefined ? { date } : {}),
    ...(targetDate !== undefined ? { targetDate } : {}),
    ...(moveTaskIds !== undefined ? { moveTaskIds } : {}),
    ...(removeTaskIds !== undefined ? { removeTaskIds } : {}),
    ...(quickTaskId !== undefined ? { quickTaskId } : {}),
    ...(quickStartAt !== undefined ? { quickStartAt } : {}),
    ...(targetStartAt !== undefined ? { targetStartAt } : {}),
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parsePreviewSearchParams(request);
    const service = createOpeningDayAdjustmentService(sql);
    const preview = await service.preview(scope, input);
    return Response.json(preview, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await readOpeningJsonBody(request);
    const parsed = dayAdjustmentPostInputSchema.parse(body);
    const service = createOpeningDayAdjustmentService(sql);

    if (parsed.action === "declare_today") {
      const { action: _action, ...declareInput } = parsed;
      const receipt = await service.declareToday(scope, declareInput);
      const preview = await service.preview(scope, { date: receipt.localDate });
      return Response.json(
        { action: "declare_today" as const, receipt, preview },
        { headers: PRIVATE_NO_STORE },
      );
    }

    if (parsed.action === "preview") {
      const { action: _action, ...previewInput } = parsed;
      const preview = await service.preview(scope, previewInput);
      return Response.json(
        { action: "preview" as const, preview },
        { headers: PRIVATE_NO_STORE },
      );
    }

    const { action: _action, ...confirmInput } = parsed;
    const receipt = await service.confirm(scope, confirmInput);
    const preview = await service.preview(scope, {
      date: receipt.sourceDate,
      targetDate: receipt.targetDate,
    });
    return Response.json(
      { action: "confirm" as const, receipt, preview },
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return withPrivateNoStore(jsonError(mapDomainError(error)));
  }
}
