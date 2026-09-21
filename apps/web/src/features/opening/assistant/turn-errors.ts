import { OpeningApiError } from "../client/api";

/** Validate an optional physical page against scope-authorized, parse-ready chunks. */
export function formatTurnError(err: unknown): string {
  if (err instanceof OpeningApiError) {
    if (err.code === "page_not_in_sources") {
      return "当前页在材料中找不到对应内容（解析 chunk 未就绪时请先清空页码再问）。";
    }
    if (err.code === "chunk_not_in_sources") {
      return "所选片段不在指定材料中。";
    }
    if (err.code === "page_chunk_mismatch") {
      return "页码与片段不一致。";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "发送失败";
}

/** Omit currentPage when unset; keep explicit page for server check. */
export function pageForSubmit(currentPage: string): number | null | undefined {
  const trimmed = currentPage.trim();
  if (trimmed === "") return undefined;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("当前页必须是正整数物理页码");
  }
  return n;
}
