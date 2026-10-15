/** MIME types the browser can preview inline (Content-Disposition: inline). */
export function normalizeSourceMime(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function isPreviewableMime(mime: string): boolean {
  const normalized = normalizeSourceMime(mime);
  return (
    normalized === "application/pdf" ||
    normalized === "text/plain" ||
    normalized === "text/markdown" ||
    normalized.startsWith("image/")
  );
}

export type SourcePreviewKind = "pdf" | "image" | "text" | null;

export function sourcePreviewKind(mime: string): SourcePreviewKind {
  const normalized = normalizeSourceMime(mime);
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("image/")) return "image";
  if (normalized === "text/plain" || normalized === "text/markdown") return "text";
  return null;
}
