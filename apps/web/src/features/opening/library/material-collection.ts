import type { SourceRecord } from "@aistudy/contracts";

export type MaterialKind = "all" | "pdf" | "image" | "text" | "audio" | "other";
export type MaterialStatus = "all" | "processing" | "ready" | "attention" | "stored";
export type MaterialSort = "newest" | "oldest" | "name" | "largest";
export type MaterialCollectionOptions = { query: string; kind: MaterialKind; status: MaterialStatus; sort: MaterialSort; page: number; pageSize: number };
export type MaterialCollection = { items: SourceRecord[]; total: number; pages: number; page: number };

function kindOf(record: SourceRecord): Exclude<MaterialKind, "all"> {
  if (record.mime === "application/pdf") return "pdf";
  if (record.mime.startsWith("image/")) return "image";
  if (record.mime.startsWith("text/")) return "text";
  if (record.mime.startsWith("audio/") || record.mime.startsWith("video/")) return "audio";
  return "other";
}
function statusOf(record: SourceRecord): Exclude<MaterialStatus, "all"> {
  if (record.uploadState === "rejected" || record.parseState === "failed") return "attention";
  if (record.uploadState === "pending") return "processing";
  if (record.parseState === "unsupported") return "stored";
  if (["not_started", "queued", "running"].includes(record.parseState)) return "processing";
  if (record.parseState === "ready") return "ready";
  return "stored";
}
function compare(a: SourceRecord, b: SourceRecord, sort: MaterialSort): number {
  if (sort === "name") return a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
  if (sort === "largest") return b.bytes - a.bytes || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
  const direction = sort === "oldest" ? 1 : -1;
  return direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
}
export function collectMaterials(records: readonly SourceRecord[], options: MaterialCollectionOptions): MaterialCollection {
  const query = options.query.trim().toLocaleLowerCase();
  const filtered = records.filter(record => (!query || record.name.toLocaleLowerCase().includes(query)) &&
    (options.kind === "all" || kindOf(record) === options.kind) &&
    (options.status === "all" || statusOf(record) === options.status)).sort((a, b) => compare(a, b, options.sort));
  const pages = Math.max(1, Math.ceil(filtered.length / options.pageSize));
  const page = Math.min(Math.max(1, options.page), pages);
  return { items: filtered.slice((page - 1) * options.pageSize, page * options.pageSize), total: filtered.length, pages, page };
}
export function materialKind(record: SourceRecord): MaterialKind { return kindOf(record); }
export function materialStatus(record: SourceRecord): MaterialStatus { return statusOf(record); }
