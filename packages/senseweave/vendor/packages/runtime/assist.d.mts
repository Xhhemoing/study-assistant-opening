import type {ChatMessage} from '../core/adapters.mjs';
import type {RuntimeOptions, OutputEnvelope} from './index.mjs';
import type {PresentationTask, MotionPreset} from '../policy/index.mjs';
export const AI_TASKS: readonly PresentationTask[];
export const AI_PROPOSAL_TYPES: readonly ('steps'|'checklist'|'chart'|'plot'|'timeline'|'compare'|'derivation')[];
/** Default contract text sent as the system/instruction of the model call. */
export const AI_ASSIST_INSTRUCTION: string;
/** What `propose` receives. The user question is included only with allowPrompt: true. */
export interface AssistRequest {
  instruction: string; answer: string; user_question?: string; task: string;
  allowedTypes: string[]; constraints: {maxSelections: number; maxVisualCost: number};
  local_candidates: {key: string; type: string; localScore: number; source: string}[];
  local_selected: string[]; motionPresets: Record<string, readonly MotionPreset[]>; styles: ('default'|'sketch')[];
}
/** Expected model JSON. Everything is validated; unknown or ungrounded parts are rejected and recorded. */
export interface AssistResponse {
  text_only?: boolean; task?: string; select?: string[];
  proposals?: {type: string; quote: string; data: unknown}[];
  motion?: Record<string, string>; style?: 'default'|'sketch'; annotations?: string[];
}
export interface GateRequest {answer: string; user_question?: string; task: string; local_selected: string[]; local_candidates: {key: string; type: string}[]}
/** Probabilities 0–1. textOnly ≥ 0.5 → keep text; needsVisual < gateThreshold → keep the local result without calling propose. */
export interface GateResult {textOnly?: number; needsVisual?: number}
export interface AIAssistOptions {
  propose: (request: AssistRequest, options: {signal: AbortSignal; onUsage: (usage: {inputTokens: number; outputTokens: number; totalTokens: number}) => void}) => Promise<AssistResponse | unknown>;
  gate?: (request: GateRequest, options: {signal: AbortSignal}) => Promise<GateResult>;
  /** default 0.6 */ gateThreshold?: number;
  /** propose deadline, default 5000 ms */ timeoutMs?: number;
  /** gate deadline, default 2000 ms */ gateTimeoutMs?: number;
  /** lifetime propose budget, default 64 */ maxCalls?: number;
  /** validated responses kept per instance, default 64 */ cacheSize?: number;
  /** send the user question to the model (default false) */ allowPrompt?: boolean;
  maxInputChars?: number;
  /** when the gate fails, still call propose (default true) */ gateFailOpen?: boolean;
  onUsage?: (event: {status: string; latencyMs: number; usage: {inputTokens: number; outputTokens: number; totalTokens: number} | null}) => void | Promise<void>;
}
export interface AIAssist {
  /** Local result now (decision.ai.status 'pending'); `upgrade` resolves to the final envelope (revision + 1 when changed) or null when skipped. */
  progressive(message: ChatMessage, options?: RuntimeOptions): {local: OutputEnvelope; upgrade: Promise<OutputEnvelope | null>};
  render(message: ChatMessage, options?: RuntimeOptions): Promise<OutputEnvelope>;
  stats(): {calls: number; gateCalls: number; cacheHits: number; cacheEntries: number; remaining: number};
  clearCache(): void;
}
export function createAIAssist(options: AIAssistOptions): Readonly<AIAssist>;
export function validateAssistResponse(raw: unknown, context: {answer: string; candidates: unknown[]; allowedTypes: string[]; maxSelections: number}): {invalid?: true; textOnly?: boolean; task?: PresentationTask | null; selectKeys?: string[]; proposals?: {id: string; block: unknown; start: number; end: number; placement: 'replace'|'after'}[]; suggestion?: {motion: Record<string, string>; style: 'default'|'sketch'; annotations: string[]; tasks?: string[]}; rejected: {type: string; reason: string}[]; proposedAny?: boolean};
