import { readPdfAsset } from "../../../../../../../features/opening/inbox/pdfjs-assets";

export async function GET(_request: Request, context: { params: Promise<{ version: string; kind: string; filename: string }> }): Promise<Response> {
  const { version, kind, filename } = await context.params;
  const asset = await readPdfAsset(version, kind, filename);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset.body as BodyInit, { headers: { "content-type": asset.contentType, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
