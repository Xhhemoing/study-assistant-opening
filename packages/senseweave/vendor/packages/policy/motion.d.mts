export const MOTION_PRESETS:readonly import('../policy/index.mjs').MotionPreset[];
export const MOTION_BY_TYPE:Readonly<Record<string,readonly import('../policy/index.mjs').MotionPreset[]>>;
export const SKETCH_TYPES:readonly string[];
export function planPresentationStyle(document:import('../core/document.mjs').PresentationDocument,options?:{context?:import('./index.mjs').PresentationContext;resolved?:Partial<import('../policy/index.mjs').ResolvedPresentationContext>;final?:boolean;capabilities?:{motion?:boolean;sketch?:boolean};suggestion?:{motion?:Record<string,string>;style?:'default'|'sketch';annotations?:(string|{phrase:string;kind?:'underline'|'circle'})[];tasks?:string[]}|null;mode?:'rich'|'text'}):import('../runtime/index.mjs').PresentationHints;
