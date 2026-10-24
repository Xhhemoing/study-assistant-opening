import type {RuntimeOptions,Diagnostic} from '../runtime/index.mjs';
import type {PresentationDocument} from '../core/document.mjs';
import type {FormatCandidate} from '../formats/index.mjs';
export type PresentationTask='auto'|'lookup'|'compare'|'trend'|'relation'|'explain'|'review'|'inspect'|'plan';
export interface PresentationContext {prompt?:string;task?:PresentationTask;preference?:'auto'|'text'|'visual';viewport?:'compact'|'wide';reducedMotion?:boolean;screenReader?:boolean;sensitive?:boolean}
export interface PresentationPolicy {mode?:'auto'|'off'|'suggest'|'always';maxEnhancements?:number;maxVisualCost?:number;minScore?:number}
export interface CandidateDecision {id:string;key:string;type:string;format:string;start:number;end:number;score:number;visualCost:number;reasons:string[];quality?:string[]}
export interface PresentationDecision {policyVersion:string;assessment?:{tasks:PresentationTask[];taskSource:string;structuredParts:number;needsReview:boolean;qualityWarnings:string[];reviewReasons:string[]};alternatives?:CandidateDecision[];state:'text'|'enhance'|'suggest'|'authored';reason:string;task?:PresentationTask;selected:CandidateDecision[];rejected:CandidateDecision[];visualCost?:number;extraModelCalls:number;scoreMeaning?:string;semantic?:{status:string;calls:number;totalCalls:number;actualProviderTokens:string;consult?:'ambiguous'|'all'|'smart';reason?:string}}
export interface Feedback {component:import('../core/document.mjs').Block['type'];task?:PresentationTask;helpful:boolean}
export interface PreferenceStore {record(feedback:Feedback):void;adjustment(component:string,task?:PresentationTask):number;snapshot():Record<string,{positive:number;negative:number}>;reset():void}
export const POLICY_VERSION:string;
export const DEFAULT_POLICY:Readonly<Required<PresentationPolicy>>;
export function normalizePolicy(policy?:PresentationPolicy):Required<PresentationPolicy>;
export function resolveContext(context?:PresentationContext): Required<Omit<PresentationContext,'prompt'>> & {noUI:boolean;exact:boolean;tasks:PresentationTask[];taskSource:'explicit'|'prompt'|'unspecified'};
export function createPreferenceStore(options?:{maxEntries?:number;/** A previous snapshot(); invalid entries are skipped. */initial?:Record<string,{positive:number;negative:number}>;/** Called after record/reset so the host can persist explicit feedback. */onChange?:(snapshot:Record<string,{positive:number;negative:number}>)=>void}):PreferenceStore;
export function planPresentation(text:string,options?:RuntimeOptions):PresentationDecision;
export function preparePresentation(text:string,options?:RuntimeOptions):{selected:(FormatCandidate & {score:number;reasons:string[];visualCost:number})[];plan:PresentationDecision;diagnostics:Diagnostic[];policy:Required<PresentationPolicy>;context:ReturnType<typeof resolveContext>;candidates:(FormatCandidate & {score:number;reasons:string[];visualCost:number;variant?:boolean;explored?:boolean})[]};
export function candidateKey(candidate:{id:string;block?:import('../core/document.mjs').Block;type?:string}):string;
export function composeAdaptive(text:string,options?:RuntimeOptions & {id?:string}):{document:PresentationDocument;plan:PresentationDecision;diagnostics:Diagnostic[]};
