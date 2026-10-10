import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { emailImportInputSchema } from "@aistudy/contracts";
import { OpeningSourceError } from "@aistudy/database";
import {
  ApiError,
  jsonError,
  mapDomainError,
} from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../features/opening/sources/upload-policy";

const EMAIL_MAX_BYTES = 25 * 1024 * 1024;

type EmailImportSourceService = Pick<
  ReturnType<typeof createOpeningSourceService>,
  "beginUpload" | "completeUpload" | "putStaging"
>;
type SourceServiceFactory = (sql: Sql) => EmailImportSourceService;
const globalForEmailImport = globalThis as typeof globalThis & {
  __openingEmailImportSourceServiceFactory?: SourceServiceFactory;
};
const sourceServiceFactory: SourceServiceFactory =
  globalForEmailImport.__openingEmailImportSourceServiceFactory ??
  createOpeningSourceService;

function basename(value: string): string {
  const name = value.split(/[\\/]/).pop() ?? "";
  return name.normalize("NFC").trim();
}

async function readEmailImportRequest(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError("VALIDATION", "multipart form body is required", 400);
  }

  const value = form.get("file");
  if (!(value instanceof File)) {
    throw new ApiError("VALIDATION", "file is required", 400);
  }
  if (!value.name.toLowerCase().endsWith(".eml")) {
    throw new ApiError("VALIDATION", "file must be an .eml message", 400);
  }
  if (value.size > EMAIL_MAX_BYTES) {
    throw new ApiError("VALIDATION", "email exceeds max 25 MiB", 413);
  }

  const bytes = new Uint8Array(await value.arrayBuffer());
  const input = emailImportInputSchema.parse({
    name: basename(value.name),
    mime: "message/rfc822",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { bytes, input };
}

/**
 * Manual .eml fallback. It creates an ordinary immutable source; it never
 * claims an authorized mailbox was synchronized or writes a connection receipt.
 * Staging uses putStaging (same-origin path) — not a browser MinIO presign.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const { bytes, input } = await readEmailImportRequest(request);
    const sources = sourceServiceFactory(sql);
    const ticket = await sources.beginUpload(principal, input);

    await sources.putStaging(principal, ticket.source.id, {
      contentType: "message/rfc822",
      bytes,
    });

    const source = await sources.completeUpload(principal, ticket.source.id);
    return Response.json(
      { sourceId: source.id, name: source.name, bytes: source.bytes, manual: true },
      { status: 201 },
    );
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
    if (error instanceof ApiError) {
      return jsonError(error);
    }
    return jsonError(mapDomainError(error));
  }
}
