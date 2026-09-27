import type { SourceRecord, UploadInput, UploadTicket } from "@aistudy/contracts";
import { resolveUploadMime } from "./upload-state";

export type LocalUploadFile = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type UploadByteProgress = {
  onBytes?: (loaded: number, total: number) => void;
  resumeSourceId?: string;
  ticket?: UploadTicket;
};

export type UploadRejected = {
  phase: "unsupported" | "interrupted";
  sourceId?: string;
  ticket?: UploadTicket;
  keptLocal: true;
  message: string;
};

type PutFn = (
  url: string,
  body: Uint8Array,
  onProgress: (loaded: number) => void,
  mime: string,
) => Promise<void>;

export type UploadClientDeps = {
  begin: (input: UploadInput) => Promise<UploadTicket>;
  complete: (sourceId: string) => Promise<SourceRecord>;
  put: PutFn;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** begin → private PUT → complete. Byte callbacks are upload progress only. */
export function createUploadClient(deps: UploadClientDeps) {
  return {
    async uploadFile(
      file: LocalUploadFile,
      progress: UploadByteProgress = {},
    ): Promise<SourceRecord | UploadRejected> {
      const mime = resolveUploadMime({ name: file.name, type: file.type });
      if (!mime) {
        return {
          phase: "unsupported",
          keptLocal: true,
          message: "不支持这个格式，未改名也未创建材料。",
        };
      }
      const ticket = progress.resumeSourceId
        ? progress.ticket
        : await deps.begin({
          name: file.name.slice(0, 180),
          mime,
          bytes: file.bytes.byteLength,
          sha256: await sha256Hex(file.bytes),
        });
      if (!ticket || (progress.resumeSourceId && ticket.source.id !== progress.resumeSourceId)) {
        return {
          phase: "interrupted",
          sourceId: progress.resumeSourceId,
          keptLocal: true,
          message: "没有可重试的上传票据，未创建第二份材料。",
        };
      }
      try {
        await deps.put(ticket.uploadUrl, file.bytes, (loaded) => {
          progress.onBytes?.(loaded, file.bytes.byteLength);
        }, mime);
      } catch {
        return {
          phase: "interrupted",
          sourceId: ticket.source.id,
          ticket,
          keptLocal: true,
          message: "上传中断，原件仍在本地。未标记为已上传。",
        };
      }
      return deps.complete(ticket.source.id);
    },
    retryComplete(sourceId: string): Promise<SourceRecord> {
      return deps.complete(sourceId);
    },
  };
}
