import type {PresentationDocument, Source} from './document.mjs';
export interface PresentationReasoning {state: 'text'|'enhance'|'suggest'|'authored'; task: string; reason: string; selected: {key:string;type:string;reasons:string[]}[]; alternatives:{key:string;type:string;reasons:string[]}[]; qualityWarnings:string[]; extraModelCalls:number; semantic:{status:string;calls:number;reason?:string}|null}
export interface RunMetrics {durationMs: number; firstTextMs: number | null; componentCount: number; warningCount: number; usage: {prompt_tokens: number; completion_tokens: number; total_tokens: number} | null}
export interface RunState {runId: string; lastSeq: number; status: 'idle' | 'streaming' | 'complete' | 'cancelled' | 'failed'; text: string; document: PresentationDocument | null; notice: string; metrics: RunMetrics | null; decision: PresentationReasoning | null; route: {template: string; reason: string} | null; startedAt: number | null; firstTextAt: number | null; committedAt: number | null}
export interface RuntimeEvent {runId: string; seq: number; type: string; at?: number; delta?: string; document?: unknown; message?: string; template?: string; reason?: string; metrics?: RunMetrics; decision?: PresentationReasoning}
export interface SSEFrame {id: string; type: string; data: string}
export function createRunState(runId: string): RunState;
export function reduceEvent(state: RunState, event: RuntimeEvent, options?: {sources?: Source[]}): RunState;
export function createSSEDecoder(onEvent: (frame: SSEFrame) => void, maxBuffer?: number): {push(chunk: string): void; end(): void; readonly pending: string};
export function consumeSSE(response: Response, onEvent: (frame: SSEFrame) => void): Promise<void>;
