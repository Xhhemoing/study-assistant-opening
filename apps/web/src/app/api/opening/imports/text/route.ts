import { ApiError, jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningRawBody } from "../../../../../features/opening/request-body";
import { captureInputSchema } from "../../../../../features/opening/imports-text/capture-input";
import { prepareCapture } from "../../../../../features/opening/imports-text/markdown";
import { saveCaptureSource } from "../../../../../features/opening/imports-text/capture-source";
import { finishCapture } from "../../../../../features/opening/imports-text/retell-task";

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope, principal } = await requireOpeningScope(request);
    const body = await readOpeningRawBody(request, 256 * 1024);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new ApiError("VALIDATION", "请提交有效的 UTF-8 JSON。", 400);
    }
    const input = captureInputSchema.parse(json);
    const capture = prepareCapture(input);
    if (!capture.content) throw new ApiError("VALIDATION", "请先粘贴讲解内容。", 400);
    const source = await saveCaptureSource(
      sql,
      principal,
      capture,
      input.clientKey,
      input.scheduleNextDayRetell,
      input.courseId ?? null,
      input.timeZone,
    );
    const task = await finishCapture(sql, scope, {
      scheduleNextDayRetell: input.scheduleNextDayRetell,
      sourceId: source.sourceId, title: capture.title, courseId: input.courseId, timeZone: input.timeZone,
    });
    return Response.json({ sourceId: source.sourceId, name: source.name, bytes: source.bytes, keySteps: capture.keySteps,
      taskId: task?.taskId ?? null, notBefore: task?.notBefore ?? null,
      deferredBehindActiveRetest: task?.deferredBehindActiveRetest ?? false },
    { status: source.replayed && (!task || task.replayed) ? 200 : 201 });
  } catch (error) {
    void request.body?.cancel().catch(() => undefined);
    return jsonError(mapDomainError(error));
  }
}
