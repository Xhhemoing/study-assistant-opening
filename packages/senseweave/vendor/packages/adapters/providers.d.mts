import type {OutputEnvelope, OutputSnapshot, RuntimeOptions} from '../runtime/index.mjs';
import type {SemanticRequest, SemanticSelection} from '../runtime/semantic.mjs';
export type ProviderProtocol='openai-chat'|'openai-responses'|'anthropic'|'gemini'|'ollama'|'cohere'|'bedrock'|'ai-sdk'|'ai-sdk-data'|'dify'|'langchain'|'text';
export type RequestProtocol='openai-chat'|'openai-responses'|'anthropic'|'gemini'|'ollama';
export type OpenAICompatiblePreset='openai'|'deepseek'|'qwen'|'moonshot'|'zhipu'|'doubao'|'siliconflow'|'openrouter'|'groq'|'mistral'|'xai'|'ollama-openai'|'lmstudio'|'vllm';
export type ProviderEvent=
  |{type:'text';delta:string}
  |{type:'refusal';delta:string}
  |{type:'finish';reason:string;complete:boolean;protocol:ProviderProtocol|null}
  |{type:'error';message:string;protocol:ProviderProtocol|null}
  |{type:'replace';text:string;protocol:ProviderProtocol|null}
  |{type:'abort'};
export interface StreamOptions {protocol?:ProviderProtocol|'auto';framing?:'sse'|'ndjson'|'lines'|'text';signal?:AbortSignal;maxChars?:number}
export type ProviderSource=Response|ReadableStream<Uint8Array|string>|AsyncIterable<unknown>;
export interface PipeResult {status:'completed'|'incomplete'|'failed'|'cancelled'|'refused'|'replaced'|'closed';protocol:ProviderProtocol|null;finishReason?:string;message?:string;replacement?:string;snapshot?:OutputSnapshot}
export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[];
export const OPENAI_COMPATIBLE_PRESETS: Readonly<Record<OpenAICompatiblePreset,string>>;
export const PROVIDER_BASE_URLS: Readonly<Record<RequestProtocol,string>>;
export function detectProtocol(packet:unknown,eventName?:string):ProviderProtocol|null;
export function createProviderDecoder(options?:{protocol?:ProviderProtocol|'auto'}):{accept(packet:unknown,eventName?:string):ProviderEvent[];end():ProviderEvent[];readonly protocol:ProviderProtocol|null;readonly finished:boolean};
export function readProviderStream(source:ProviderSource,options?:StreamOptions):AsyncGenerator<ProviderEvent,void>;
/** Binds the supplied source to an optional session close signal as well as options.signal. */
export function pipeProviderStream(source:ProviderSource,session:{readonly signal?:AbortSignal;push(delta:string):void;finish():unknown;fail(message?:string):unknown;cancel():unknown;getState?():OutputSnapshot},options?:StreamOptions):Promise<PipeResult>;
export function extractProviderText(response:unknown,options?:{protocol?:ProviderProtocol|'auto'}):{protocol:ProviderProtocol;text:string;refusal:string;finishReason:string;complete:boolean};
export function fromProviderResponse(response:unknown,options?:RuntimeOptions&{protocol?:ProviderProtocol|'auto';messageId?:string}):OutputEnvelope;
export interface ProviderRequestOptions {protocol?:RequestProtocol;preset?:OpenAICompatiblePreset;baseURL?:string;apiKey?:string;model:string;system?:string;prompt?:string;messages?:{role:'user'|'assistant';content:string}[];stream?:boolean;maxTokens?:number;tokenParameter?:'max_tokens'|'max_completion_tokens';json?:boolean;headers?:Record<string,string>;temperature?:number}
export function buildProviderRequest(options:ProviderRequestOptions):{url:string;protocol:RequestProtocol;init:{method:'POST';headers:Record<string,string>;body:string}};
export function parseSelection(text:string):SemanticSelection;
export function createProviderSelect(options:Omit<ProviderRequestOptions,'system'|'prompt'|'messages'|'stream'|'maxTokens'>&{fetch?:typeof fetch}):(request:SemanticRequest,options?:{signal?:AbortSignal;maxOutputTokens?:number})=>Promise<SemanticSelection>;

/** A ready `propose` for createAIAssist (server-side only). Returns the model JSON unvalidated; createAIAssist validates and grounds it. */
export function createProviderPropose(options:Omit<ProviderRequestOptions,'system'|'prompt'|'messages'|'stream'|'maxTokens'>&{fetch?:typeof fetch;temperature?:number;maxOutputTokens?:number}):(request:import('../runtime/assist.mjs').AssistRequest,options?:{signal?:AbortSignal;onUsage?:(usage:{inputTokens:number;outputTokens:number;totalTokens:number})=>void})=>Promise<unknown>;
