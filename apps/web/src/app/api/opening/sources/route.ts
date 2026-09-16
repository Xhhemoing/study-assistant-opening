import { uploadInputSchema } from "@aistudy/contracts";
import { OpeningSourceError } from "@aistudy/database";
import {
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../features/auth/service";
import { createOpeningSourceService } from "../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../features/opening/sources/upload-policy";
import { getAuthRuntime } from "../../../../server/runtime";

/** Delegate list/beginUpload to materials source-service (avoid dual write). */
export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const sources = await createOpeningSourceService(runtime.sql).listSources(
      principal,
    );
    return Response.json(sources);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const body = uploadInputSchema.parse(await request.json());
    const origin = new URL(request.url).origin;
    const stagingAbsoluteUrl = `${origin}/api/opening/sources/__SOURCE_ID__/staging`;
    const ticket = await createOpeningSourceService(runtime.sql).beginUpload(
      principal,
      body,
      stagingAbsoluteUrl,
    );
    return Response.json(ticket, { status: 201 });
  } catch (error) {
    if (error instanceof OpeningSourceError) {
      const status =
        error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status },
      );
    }
    if (error instanceof UploadPolicyError) {
      return Response.json(
        { error: { code: "VALIDATION", message: error.message } },
        { status: 400 },
      );
    }
    return jsonError(mapDomainError(error));
  }
}
