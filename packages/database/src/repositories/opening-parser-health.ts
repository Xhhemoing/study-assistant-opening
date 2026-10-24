import type { Sql } from "postgres";

export const PARSER_OCR_FILES = ["ch_PP-OCRv4_det_mobile.pth", "ch_ptocr_mobile_v2.0_cls_mobile.pth", "ch_PP-OCRv4_rec_mobile.pth", "ppocr_keys_v1.txt"] as const;
export type ParserOcrStatus = "not_configured" | "missing_files" | "preflight_failed" | "ready";
export type ParserOcrHealth = {
  status: ParserOcrStatus;
  directoryConfigured: boolean;
  directoryExists: boolean;
  missingFiles: string[];
  inferenceMs: number | null;
};
export type ParserOcrObservation = ParserOcrHealth & { checkedAt: string; expiresAt: string };
export const PARSER_HEALTH_TTL_MS = 10 * 60_000;

/** Validate subprocess/persisted data; paths and stderr never cross this boundary. */
export function parseParserOcrHealth(value: unknown): ParserOcrHealth {
  if (!value || typeof value !== "object") throw new TypeError("invalid OCR health");
  const row = value as Record<string, unknown>;
  if (!["not_configured", "missing_files", "preflight_failed", "ready"].includes(String(row.status))
    || typeof row.directoryConfigured !== "boolean" || typeof row.directoryExists !== "boolean"
    || !Array.isArray(row.missingFiles) || row.missingFiles.some(file => !PARSER_OCR_FILES.includes(file))
    || (row.inferenceMs !== null && (!Number.isSafeInteger(row.inferenceMs) || Number(row.inferenceMs) < 0))) {
    throw new TypeError("invalid OCR health");
  }
  if (row.status === "ready" && (!row.directoryConfigured || !row.directoryExists || row.missingFiles.length || row.inferenceMs === null)) {
    throw new TypeError("OCR readiness requires a successful inference");
  }
  return { status: row.status as ParserOcrStatus, directoryConfigured: row.directoryConfigured, directoryExists: row.directoryExists,
    missingFiles: row.missingFiles as string[], inferenceMs: row.inferenceMs as number | null };
}

export function createOpeningParserHealthRepository(sql: Sql) {
  return {
    async record(workerId: string, raw: ParserOcrHealth): Promise<void> {
      const report = parseParserOcrHealth(raw);
      await sql`INSERT INTO opening_parser_health(worker_id,status,directory_configured,directory_exists,missing_files,inference_ms,checked_at,expires_at)
        VALUES(${workerId},${report.status},${report.directoryConfigured},${report.directoryExists},${sql.json(report.missingFiles)},${report.inferenceMs},now(),now() + ${PARSER_HEALTH_TTL_MS} * interval '1 millisecond')
        ON CONFLICT(worker_id) DO UPDATE SET status=EXCLUDED.status,directory_configured=EXCLUDED.directory_configured,
          directory_exists=EXCLUDED.directory_exists,missing_files=EXCLUDED.missing_files,inference_ms=EXCLUDED.inference_ms,
          checked_at=EXCLUDED.checked_at,expires_at=EXCLUDED.expires_at`;
    },
    async retire(workerId: string): Promise<void> {
      await sql`UPDATE opening_parser_health SET expires_at=LEAST(expires_at,now()) WHERE worker_id=${workerId}`;
    },
    /** All live parser consumers must support OCR. One ready machine is not enough
     * when another consumer can take the same scanned-PDF job without OCR. */
    async read(): Promise<ParserOcrObservation | null> {
      const [row] = await sql`SELECT * FROM opening_parser_health WHERE expires_at > now()
        ORDER BY (status = 'ready') ASC, checked_at DESC LIMIT 1`;
      if (!row) return null;
      return { ...parseParserOcrHealth({ status: row.status, directoryConfigured: row.directory_configured,
        directoryExists: row.directory_exists, missingFiles: row.missing_files, inferenceMs: row.inference_ms }),
      checkedAt: new Date(row.checked_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
    },
  };
}
