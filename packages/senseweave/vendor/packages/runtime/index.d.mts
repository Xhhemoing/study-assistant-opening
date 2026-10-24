import type {PresentationDocument, Source} from '../core/document.mjs';
import type {ChatMessage} from '../core/adapters.mjs';
import type {CapabilityInput} from './capabilities.mjs';
import type {InstructionContext} from './instructions.mjs';
import type {FormatOptions} from '../formats/index.mjs';
import type {PresentationPolicy,PresentationContext,PresentationDecision,PreferenceStore,Feedback} from '../policy/index.mjs';
export interface RuntimeOptions extends FormatOptions {sources?:Source[];capabilities?:CapabilityInput;mode?:'auto'|'text'|'rich';title?:string;format?:'text'|'markdown';policy?:PresentationPolicy;context?:PresentationContext;preferences?:PreferenceStore;cache?:{maxEntries?:number;maxChars?:number};signal?:AbortSignal;/** Offer every valid chart/plot view of a table; set by the semantic selector. */exploreVariants?:boolean;/** Candidate keys chosen by a semantic selector. */selectionKeys?:string[]}
export interface Diagnostic {code:string;severity:'info'|'warning';message:string;start?:number;end?:number;measure?:'rows'|'columns'|'cell'|'nodes'|'edges';limit?:number;actual?:number}
export interface OutputEnvelope {version:'0.5';runtimeVersion:'0.5.0-rc.1';messageId:string;content:string;document:PresentationDocument;text:string;mode:'text'|'rich';pending:{type:string;known:boolean}|null;diagnostics:Diagnostic[];decision:PresentationDecision}
export interface OutputSnapshot extends OutputEnvelope {status:'streaming'|'completed'|'cancelled'|'failed';reason:string;chunks:number;renders:number;compilations:number}
export interface SessionOptions extends RuntimeOptions {messageId?:string;signal?:AbortSignal;throttleMs?:number;onUpdate?:(state:OutputSnapshot)=>void;onError?:(error:unknown)=>void}
export interface OutputSession {/** Aborted on completion, cancellation, failure or disposal. Does not abort an unrelated host request. */readonly signal:AbortSignal;push(delta:string):void;finish():OutputSnapshot;cancel():OutputSnapshot;fail(message?:string):OutputSnapshot;flush():OutputSnapshot;getState():OutputSnapshot;/** Silently closes an active session as cancelled; no observer notification. */dispose():void}
export interface SenseWeaveRuntime {render(message:ChatMessage,options?:RuntimeOptions):OutputEnvelope;plan(text:string,options?:RuntimeOptions):PresentationDecision;feedback(event:Feedback):void;resetPreferences():void;getStats():{cacheHits:number;cacheMisses:number;cacheEntries:number;cacheChars:number;extraModelCalls:number};clearCache():void;instructions(context?:InstructionContext):string;createSession(options?:SessionOptions):OutputSession}
export function compileMessage(message:ChatMessage,options?:RuntimeOptions):OutputEnvelope;
export function createOutputSession(options?:SessionOptions):OutputSession;
export function createSenseWeave(options?:RuntimeOptions):Readonly<SenseWeaveRuntime>;
