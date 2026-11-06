import type { SourceRecord, UploadInput, UploadTicket } from "@aistudy/contracts";
import { resolveUploadMime, unsupportedUploadMessage } from "./upload-state";
import { uploadErrorMessage } from "./upload-error";
import type { SessionIdentity } from "../../auth/session-identity";

export type LocalUploadFile = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type UploadByteProgress = {
  signal?: AbortSignal;
  expectedIdentity?: SessionIdentity | null;
  uploadId?: string;
  onBytes?: (loaded: number, total: number) => void;
  resumeSourceId?: string;
  ticket?: UploadTicket;
  completionPending?: boolean;
};

export type UploadRejected = {
  phase: "unsupported" | "interrupted";
  sourceId?: string;
  ticket?: UploadTicket;
  keptLocal: true;
  completionPending?: boolean;
  message: string;
};

type PutFn = (
  url: string,
  body: Uint8Array,
  onProgress: (loaded: number) => void,
  mime: string,
  expectedIdentity?: SessionIdentity | null,
  signal?: AbortSignal,
) => Promise<void>;

export type UploadClientDeps = {
  begin: (input: UploadInput, expectedIdentity?: SessionIdentity | null, signal?: AbortSignal) => Promise<UploadTicket>;
  complete: (sourceId: string, expectedIdentity?: SessionIdentity | null) => Promise<SourceRecord>;
  put: PutFn;
  resolvePutUrl?: (ticket: UploadTicket) => string;
  /** Reissue lease for pending source; required for retry (never reuse expired uploadUrl). */
  refreshTicket?: (sourceId: string, expectedIdentity?: SessionIdentity | null, signal?: AbortSignal) => Promise<UploadTicket>;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectionDetail(error: unknown): string {
  const message = uploadErrorMessage(error, "");
  return message ? `（${message}）` : "";
}

/** begin → private PUT → complete. Byte callbacks are upload progress only. */
export function createUploadClient(deps: UploadClientDeps) {
  // Direct callers also retain the identity after an unknown begin response.
  // Queue callers provide an explicit id so separate selections stay distinct.
  const pendingBegins = new WeakMap<LocalUploadFile, string>();
  return {
    async uploadFile(
      file: LocalUploadFile,
      progress: UploadByteProgress = {},
    ): Promise<SourceRecord | UploadRejected> {
      const cancelled = async (ticket?: UploadTicket): Promise<UploadRejected> => {
        return { phase: "interrupted", keptLocal: true, sourceId: ticket?.source.id ?? progress.uploadId ?? pendingBegins.get(file),
          ticket, message: "上传已停止，未发送保存请求；暂存记录待核对，可重试。" };
      };
      if (progress.resumeSourceId && progress.completionPending) {
        if (progress.signal?.aborted) {
          return { phase: "interrupted", sourceId: progress.resumeSourceId, ticket: progress.ticket,
            completionPending: true, keptLocal: true, message: "可能已保存，待核对。请重试核对同一材料。" };
        }
        try {
          const result = await deps.complete(progress.resumeSourceId, progress.expectedIdentity);
          pendingBegins.delete(file);
          return result;
        }
        catch (error) {
          return { phase: "interrupted", sourceId: progress.resumeSourceId, ticket: progress.ticket,
            completionPending: true, keptLocal: true,
            message: `可能已保存，待核对。请重试核对同一材料。${rejectionDetail(error)}` };
        }
      }
      const mime = resolveUploadMime({ name: file.name, type: file.type });
      if (progress.signal?.aborted) return cancelled(progress.ticket);
      if (!mime) {
        return {
          phase: "unsupported",
          keptLocal: true,
          message: unsupportedUploadMessage({ name: file.name, type: file.type }),
        };
      }
      let ticket: UploadTicket | undefined;
      try {
        if (progress.resumeSourceId) {
          // Retry: refresh ticket (same source id) — never reuse expired uploadUrl; never begin a new row.
          ticket = deps.refreshTicket
            ? await deps.refreshTicket(progress.resumeSourceId, progress.expectedIdentity, progress.signal)
            : progress.ticket;
        } else {
          const uploadId = progress.uploadId ?? pendingBegins.get(file) ?? globalThis.crypto.randomUUID();
          pendingBegins.set(file, uploadId);
          const sha256 = await sha256Hex(file.bytes);
          if (progress.signal?.aborted) return cancelled();
          ticket = await deps.begin({
            name: file.name.slice(0, 180),
            mime,
            bytes: file.bytes.byteLength,
            sha256,
            uploadId,
          }, progress.expectedIdentity, progress.signal);
        }
      } catch (error) {
        const detail = rejectionDetail(error);
        return {
          phase: "interrupted",
          sourceId: progress.resumeSourceId ?? progress.uploadId ?? pendingBegins.get(file),
          keptLocal: true,
          message: progress.resumeSourceId
            ? `上传票据刷新失败，原件仍在本地。未创建第二份材料。${detail}`
            : `上传准备结果待核对，原件仍在本地；重试将沿用同一上传标识。${detail}`,
        };
      }
      if (!ticket || (progress.resumeSourceId && ticket.source.id !== progress.resumeSourceId)) {
        return {
          phase: "interrupted",
          sourceId: progress.resumeSourceId,
          keptLocal: true,
          message: "没有可重试的上传票据，未创建第二份材料。",
        };
      }
      if (progress.signal?.aborted) return cancelled(ticket);
      try {
        await deps.put(deps.resolvePutUrl?.(ticket) ?? ticket.uploadUrl, file.bytes, (loaded) => {
          if (!progress.signal?.aborted) progress.onBytes?.(loaded, file.bytes.byteLength);
        }, mime, progress.expectedIdentity, progress.signal);
      } catch (error) {
        if (progress.signal?.aborted) return cancelled(ticket);
        const detail = rejectionDetail(error);
        return {
          phase: "interrupted",
          sourceId: ticket.source.id,
          ticket,
          keptLocal: true,
          message: `上传中断，原件仍在本地。未标记为已上传。${detail}`,
        };
      }
      if (progress.signal?.aborted) return cancelled(ticket);
      try {
        // Complete may have committed already; do not abort its receipt.
        const result = await deps.complete(ticket.source.id, progress.expectedIdentity);
        pendingBegins.delete(file);
        return result;
      } catch (error) {
        return {
          phase: "interrupted",
          sourceId: ticket.source.id,
          ticket,
          keptLocal: true,
          completionPending: true,
          message: `可能已保存，待核对。请重试核对同一材料。${rejectionDetail(error)}`,
        };
      }
    },
    retryComplete(sourceId: string, expectedIdentity?: SessionIdentity | null): Promise<SourceRecord> {
      return deps.complete(sourceId, expectedIdentity);
    },
  };
}
