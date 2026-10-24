import type {RuntimeOptions,OutputEnvelope} from './index.mjs';
import type {ChatMessage} from '../core/adapters.mjs';
/** Structure only: labels, measurement kinds, units and counts. Cell values are never sent. */
export type CandidateStructure = Record<string, unknown>;
export interface SemanticRequest {task:string;tasks:string[];preference:string;reading:{viewport:string;screenReader:boolean;reducedMotion:boolean};constraints:{maxSelections:number;maxVisualCost:number};localVerdict:{state:string;selectedKeys:string[];reviewReasons:string[]};candidates:{key:string;group:string;visualCost:number;type:string;format:string;score:number;reasons:string[];structure:CandidateStructure}[];instruction:string;prompt?:string}
export interface SemanticSelection {selectedKeys:string[];reason?:string}
export interface SemanticSelectorOptions {
  select:(request:SemanticRequest,options:{signal:AbortSignal;maxOutputTokens:number})=>Promise<SemanticSelection>;
  maxCalls?:number;timeoutMs?:number;maxInputChars?:number;allowPrompt?:boolean;
  /** 'all' (compatibility default): review every valid view. 'smart': review only uncertain/mixed tasks. 'ambiguous': borderline scores only. */
  consult?:'all'|'ambiguous'|'smart';
  /** Send column/axis labels and units (default true). false sends kinds and counts only. */
  shareStructure?:boolean;
}
export function createSemanticSelector(options:SemanticSelectorOptions):{render(message:ChatMessage,options?:RuntimeOptions):Promise<OutputEnvelope>;stats():{calls:number;remaining:number;cacheEntries:number};clearCache():void};
