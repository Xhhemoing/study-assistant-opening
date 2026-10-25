import type {PresentationDocument, Source} from './document.mjs';
export interface ChatMessage {id?: string; content?: string | unknown[] | null; parts?: unknown[]; presentation?: unknown; revision?: number; title?: string}
export function extractText(message: ChatMessage): string;
export function fromChatMessage(message: ChatMessage, options?: {sources?: Source[]; format?: 'text' | 'markdown'; onDiagnostic?: (diagnostic: {code: string; message: string}) => void}): PresentationDocument;
export function adaptAGUI(event: {type: string; delta?: string; message?: string}, context: {runId: string; seq: number}): Record<string, unknown> | null;
