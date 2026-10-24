import type {OutputEnvelope, RuntimeOptions, OutputSnapshot} from '../runtime/index.mjs';
import type {ChatMessage} from '../core/adapters.mjs';
export function toAISDKDataPart(envelope: OutputEnvelope): {type: 'data-senseweave'; id: string; data: OutputEnvelope};
export function fromAISDKMessage(message: ChatMessage, options?: RuntimeOptions): OutputEnvelope;
export function stripSenseWeaveParts<T extends {parts?: unknown[]}>(message: T): T;
export interface MCPTextResult {content: {type: 'text'; text: string}[]; isError: false}
export function toMCPResult(envelope: OutputEnvelope, options?: {uiMeta?: false}): MCPTextResult & {structuredContent: {senseweave: OutputEnvelope}};
export function toMCPResult(envelope: OutputEnvelope, options: {uiMeta: true}): MCPTextResult & {structuredContent: {senseweaveSummary: {version: string; messageId: string; mode: string; components: string[]; state: string}}; _meta: {senseweave: OutputEnvelope}};
export function toMCPResult(envelope: OutputEnvelope, options: {uiMeta: boolean}): MCPTextResult & {structuredContent: Record<string, unknown>; _meta?: {senseweave: OutputEnvelope}};
/** TEXT_MESSAGE_* events require a valid messageId. Non-assistant message lifecycles are ignored. */
export interface AGUIEvent {type: string; runId?: string; messageId?: string; role?: string; delta?: string; message?: string; [key: string]: unknown}
export function createAGUIBridge(options: RuntimeOptions & {runId: string; maxMessages?: number; throttleMs?: number; onUpdate?: (state: OutputSnapshot) => void}): {accept(event: AGUIEvent): boolean; getState(): {runId: string; status: string; messages: OutputSnapshot[]}; dispose(): void};
export * from './providers.mjs';
