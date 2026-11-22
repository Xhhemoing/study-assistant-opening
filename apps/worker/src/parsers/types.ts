export type PdfSealMode = "section_sealed" | "inline_sealed" | "inline_proof_sealed";
export type ParserInput = { path: string; mime: string; maxPages: number; timeoutSeconds?: number; pageStart?: number; pageEnd?: number; initialSealMode?: PdfSealMode; initialInWorkedExample?: boolean; initialInExercise?: boolean };
export type VisualPageKind = "scan" | "formula" | "table" | "picture";
export type ParsedPage = { page: number; text: string; imagePath: string | null; visualKinds?: VisualPageKind[]; sectionSealedAtEnd?: boolean; inlineSealedAtEnd?: boolean; inlineProofSealedAtEnd?: boolean; hadSealedContent?: boolean; inWorkedExampleAtEnd?: boolean; inExerciseAtEnd?: boolean };
export type ParserRunner = (argv: string[], signal: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
export type ParseDocument = (input: ParserInput, signal: AbortSignal) => Promise<ParsedPage[]>;
