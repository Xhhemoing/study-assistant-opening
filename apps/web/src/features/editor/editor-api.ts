export type EditorBlock = {
  id: string;
  type: string;
  position: number;
  content: Record<string, unknown>;
};

export type EditorBlockInput = {
  id: string;
  type: string;
  content: unknown;
};

export type EditorDocument = {
  id: string;
  title: string;
  lifecycle: string;
  currentRevisionNumber: number;
  blocks: EditorBlock[];
  updatedAt?: string;
};

export type EditorRevision = {
  id?: string;
  documentId?: string;
  revisionNumber: number;
  parentRevisionNumber?: number | null;
  title: string;
  lifecycle?: string;
  reason?: string;
  blocks: unknown[];
  createdAt?: string;
};

export type CreateDocumentInput = {
  title: string;
  blocks: EditorBlockInput[];
  lifecycle?: string;
};

export type UpdateDocumentInput = {
  title?: string;
  blocks: EditorBlockInput[];
  reason?: string;
};

export class EditorApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EditorApiError";
    this.code = code;
    this.status = status;
  }
}

type FetchImpl = typeof fetch;

type ErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createEditorApi(fetchImpl: FetchImpl = fetch) {
  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetchImpl(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new EditorApiError(
        errorBody?.error?.code ?? "REQUEST_FAILED",
        errorBody?.error?.message ?? "请求失败，请稍后重试。",
        response.status,
      );
    }
    return body as T;
  }

  return {
    async fetchDocument(documentId: string): Promise<EditorDocument> {
      const result = await request<{ document: EditorDocument }>(
        `/api/documents/${encodeURIComponent(documentId)}`,
        { method: "GET" },
      );
      return result.document;
    },

    async createDocument(input: CreateDocumentInput): Promise<EditorDocument> {
      const result = await request<{ document: EditorDocument }>(
        "/api/documents",
        { method: "POST", body: JSON.stringify(input) },
      );
      return result.document;
    },

    async saveDocument(
      documentId: string,
      input: UpdateDocumentInput,
    ): Promise<EditorDocument> {
      const result = await request<{ document: EditorDocument }>(
        `/api/documents/${encodeURIComponent(documentId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      return result.document;
    },

    async fetchRevisions(documentId: string): Promise<EditorRevision[]> {
      const result = await request<{ revisions: EditorRevision[] }>(
        `/api/documents/${encodeURIComponent(documentId)}/revisions`,
        { method: "GET" },
      );
      return result.revisions;
    },
  };
}

export type EditorApi = ReturnType<typeof createEditorApi>;
