import type {RuntimeOptions,Diagnostic} from '../runtime/index.mjs';
import type {PresentationDocument} from '../core/document.mjs';
import type {FormatCandidate,Fidelity,SourceReference,FieldProjection} from '../formats/index.mjs';
export type PresentationTask='auto'|'lookup'|'compare'|'trend'|'relation'|'explain'|'review'|'inspect'|'plan';
export interface PresentationContext {prompt?:string;task?:PresentationTask;preference?:'auto'|'text'|'visual';viewport?:'compact'|'wide';reducedMotion?:boolean;screenReader?:boolean;sensitive?:boolean;constraints?:{allowEnhancements?:boolean;allowedComponents?:import('../core/document.mjs').Block['type'][]};fields?:{x:string;y:string};/** 'sketch' prefers hand-drawn rendering, 'plain' turns it off; default auto (explicit explain/review tasks). */style?:'auto'|'sketch'|'plain';/** Teaching intent; 'derive' enables board derivations. */intent?:string;/** Underline key phrases in prose. */annotate?:boolean}
export interface PresentationPolicy {mode?:'auto'|'off'|'suggest'|'always';maxEnhancements?:number;maxVisualCost?:number;minScore?:number}
export interface CandidateDecision {id:string;key:string;type:string;format:string;start:number;end:number;score:number;visualCost:number;reasons:string[];quality?:string[];fidelity?:Fidelity;sourceRef?:SourceReference;projection?:FieldProjection;/** 'after': supplementary view grounded verbatim in one contiguous span. */placement?:'after';/** How a supplementary view is shown: 'replace' stands in for its span (original behind “查看原文”), 'append' follows it. */display?:'replace'|'append'}
export interface PresentationDecision {policyVersion:string;assessment?:{tasks:PresentationTask[];taskSource:string;structuredParts:number;needsReview:boolean;qualityWarnings:string[];reviewReasons:string[]};alternatives?:CandidateDecision[];state:'text'|'enhance'|'suggest'|'authored';reason:string;task?:PresentationTask;selected:CandidateDecision[];rejected:CandidateDecision[];visualCost?:number;extraModelCalls:number;scoreMeaning?:string;semantic?:import('../runtime/semantic.mjs').SemanticTelemetry;/** Which motion preset/sketch style was chosen and why (decoration only). */presentation?:{motion:Record<string,MotionPreset>;motionReason:string;sketch:boolean;sketchReason:string;annotations:number};/** Present when createAIAssist handled this answer. */ai?:AIDecision}
export type MotionPreset='none'|'reveal'|'stagger'|'draw'|'step-through'|'highlight'|'count-up'|'write';
export interface AIDecision {status:'pending'|'accepted'|'cache-hit'|'rejected'|'text-only'|'gated'|'gated-text-only'|'gate-failed'|'timeout'|'cancelled'|'error'|'invalid'|'call-budget'|'skipped'|'skipped-sensitive'|'text-requested'|'disabled'|'authored'|'input-budget';calls:number;gateCalls:number;latencyMs:number;task?:PresentationTask|null;accepted?:{key:string;type:string;source:'model-proposal'|'local-candidate'}[];rejected?:{type:string;reason:string;key?:string;proposal?:number}[];style?:'default'|'sketch';motion?:Record<string,MotionPreset>;usage?:{inputTokens:number;outputTokens:number;totalTokens:number}|null;gate?:{textOnly:number|null;needsVisual:number|null};error?:string}

export interface Feedback {component:import('../core/document.mjs').Block['type'];task?:PresentationTask;helpful:boolean}
export interface PreferenceStore {record(feedback:Feedback):void;adjustment(component:string,task?:PresentationTask):number;snapshot():Record<string,{positive:number;negative:number}>;reset():void}
export const POLICY_VERSION:string;
export const DEFAULT_POLICY:Readonly<Required<PresentationPolicy>>;
export function normalizePolicy(policy?:PresentationPolicy):Required<PresentationPolicy>;
export type ResolvedPresentationContext=Required<Omit<PresentationContext,'prompt'|'constraints'|'fields'>> & {noUI:boolean;exact:boolean;tasks:PresentationTask[];allowedComponents:string[];taskSource:'explicit'|'prompt'|'unspecified'};
export function resolveContext(context?:PresentationContext):ResolvedPresentationContext;
export function createPreferenceStore(options?:{maxEntries?:number;/** A previous snapshot(); invalid entries are skipped. */initial?:Record<string,{positive:number;negative:number}>;/** Called after record/reset so the host can persist explicit feedback. */onChange?:(snapshot:Record<string,{positive:number;negative:number}>)=>void}):PreferenceStore;
export function planPresentation(text:string,options?:RuntimeOptions):PresentationDecision;
export type ScoredCandidate=FormatCandidate & {score:number;reasons:string[];visualCost:number;variant?:boolean;explored?:boolean};
export interface PreparedPresentation {selected:ScoredCandidate[];plan:PresentationDecision;diagnostics:Diagnostic[];policy:Required<PresentationPolicy>;context:ResolvedPresentationContext;candidates:ScoredCandidate[];cap:import('../runtime/capabilities.mjs').Capabilities;veto:string|null;structuredParts:number;authoredBy?:'model'|'host'|'user'}
export function preparePresentation(text:string,options?:RuntimeOptions):PreparedPresentation;
export function choosePresentation(prepared:PreparedPresentation,selectionKeys?:string[]):PreparedPresentation;
export function prepareAuthored(document:PresentationDocument,options?:RuntimeOptions):PreparedPresentation;
export function composePrepared(text:string,prepared:PreparedPresentation,options?:RuntimeOptions & {id?:string}):{document:PresentationDocument;plan:PresentationDecision;diagnostics:Diagnostic[]};
/** How supplementary views are shown. Default 'replace'. */
export type Placement='replace'|'append';
/** Validate a placement option (contract code PLACEMENT); undefined means 'replace'. */
export function normalizePlacement(value?:Placement):Placement;
/** True when a selected candidate is shown in place of its verbatim source span. */
export function replacesSource(candidate:{placement?:string;fidelity?:{level:string};sourceRef?:{kind:string};start:number;end:number},placement?:Placement):boolean;
export function candidateKey(candidate:{id:string;block?:import('../core/document.mjs').Block;type?:string}):string;
export function composeAdaptive(text:string,options?:RuntimeOptions & {id?:string}):{document:PresentationDocument;plan:PresentationDecision;diagnostics:Diagnostic[]};
