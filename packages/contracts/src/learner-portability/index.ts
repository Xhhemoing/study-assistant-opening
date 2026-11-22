import { z } from "zod";
import { hasPortableFrontmatter } from "./frontmatter";

export const LEARNER_PORTABILITY_VERSION = 1;

const privateIdentifier = /(?:^|[/_.-])(?:0109|skillbeliefv1|sealed)(?:$|[/_.-])/iu;
const portableId = z.string().min(1).refine(value => !privateIdentifier.test(value), "Private identifiers are excluded");
const portablePath = portableId.refine(path => path.split("/").every(segment =>
  segment !== "" && segment !== "." && segment !== ".." && !/[\\:\p{Cc}]/u.test(segment)), "Expected a relative portable path");
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

export const learnerPackageManifestSchema = z.strictObject({
  format: z.literal("aistudy-learner-package"),
  version: z.literal(LEARNER_PORTABILITY_VERSION),
  notes: count,
  decks: count,
  reviews: count,
});

export const obsidianLinkSchema = z.strictObject({
  target: z.string().refine(value => !privateIdentifier.test(value), "Private targets are excluded"),
  fragment: z.string().nullable(),
  alias: z.string().nullable(),
  embed: z.boolean(),
  offset: count,
}).refine(link => link.target !== "" || Boolean(link.fragment), "Expected a note or fragment target");

export const portableMarkdownNoteSchema = z.strictObject({
  path: portablePath,
  format: z.enum(["markdown", "obsidian"]),
  markdown: z.string().refine(hasPortableFrontmatter, "Unrecognized or private YAML frontmatter"),
  links: z.array(obsidianLinkSchema),
});

export const portableAnkiCardSchema = z.strictObject({
  id: portableId.regex(/^[^\t\r\n]+$/u),
  front: z.string(),
  back: z.string(),
  source: z.string(),
  tags: z.array(z.string().regex(/^\S+$/u)),
});

export const portableAnkiDeckSchema = z.strictObject({
  name: z.string().regex(/^[^\r\n]+$/u),
  cards: z.array(portableAnkiCardSchema),
});

export const portableFsrsSnapshotSchema = z.strictObject({
  version: z.literal("fsrs-5.4.2"),
  cardId: portableId,
  dueAt: instant,
  lastReviewAt: instant.nullable(),
  stability: z.number().nonnegative(),
  difficulty: z.number().min(0).max(10),
  elapsedDays: count,
  scheduledDays: count,
  learningSteps: count,
  reps: count,
  lapses: count,
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
});

/** Strict nested shapes admit only the portable fields. */
export const learnerPackageSchema = z.strictObject({
  manifest: learnerPackageManifestSchema,
  notes: z.array(portableMarkdownNoteSchema),
  decks: z.array(portableAnkiDeckSchema),
  reviews: z.array(portableFsrsSnapshotSchema),
}).superRefine((bundle, context) => {
  for (const field of ["notes", "decks", "reviews"] as const) {
    if (bundle.manifest[field] !== bundle[field].length) {
      context.addIssue({ code: "custom", path: ["manifest", field], message: "Manifest count does not match payload" });
    }
  }
});

export type LearnerPackageManifest = z.infer<typeof learnerPackageManifestSchema>;
export type ObsidianLink = z.infer<typeof obsidianLinkSchema>;
export type PortableMarkdownNote = z.infer<typeof portableMarkdownNoteSchema>;
export type PortableAnkiCard = z.infer<typeof portableAnkiCardSchema>;
export type PortableAnkiDeck = z.infer<typeof portableAnkiDeckSchema>;
export type PortableFsrsSnapshot = z.infer<typeof portableFsrsSnapshotSchema>;
export type LearnerPackage = z.infer<typeof learnerPackageSchema>;
