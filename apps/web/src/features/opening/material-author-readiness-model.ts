import { z } from "zod";
import {
  adaptMaterialCourseFullPackage, materialCourseFullPackageSchema,
} from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import {
  assessMaterialCoursePackageReadiness, type MaterialReadinessAuthority,
} from "../../../../../packages/domain/src/opening/material-course-package-readiness";
import {
  createMaterialSourceLocator, type MaterialSourceLocatorRequest,
} from "../../../../../packages/domain/src/opening/material-source-locator";

const optionsSchema = z.object({ providedSources: z.unknown().optional(), bindings: z.unknown().optional() }).strict();
export type MaterialAuthorReadinessOptions = z.infer<typeof optionsSchema>;

/** Private author-review host composition, not a learner/first-answer DTO or an endpoint.
 * The host must authorize input delivery separately. One captured RAW input feeds the
 * canonical adapter, domain readiness and source locator; no caller candidate/report is
 * accepted. No fetch, PDF-byte verification, help/exposure events or writes occur here.
 * The optional server dependency is forwarded, never implemented/defaulted here. A
 * schema-valid binding or a true callback is NOT host authentication or authorization.
 * Exceptions (including verifier failures) propagate; callers must not display raw errors.
 */
export function readMaterialAuthorReadiness(
  input: unknown,
  options: MaterialAuthorReadinessOptions = {},
  authority?: MaterialReadinessAuthority,
) {
  // Preserve raw basename/URL spelling for the locator; parsing first would trim it.
  const snapshot: unknown = structuredClone(input);
  const captured = optionsSchema.parse(structuredClone(options));
  // Capture dependency properties once. Each verification gets its own private value
  // copy, so callback mutation cannot alter later purposes or the report being built.
  const host = authority && { asOf: authority.asOf, verifyBinding: authority.verifyBinding };
  const isolatedAuthority: MaterialReadinessAuthority | undefined = host && {
    asOf: host.asOf,
    verifyBinding: request => host.verifyBinding.call(authority, structuredClone(request)),
  };
  const locator = createMaterialSourceLocator(snapshot, captured.providedSources);
  const pack = materialCourseFullPackageSchema.parse(snapshot);
  const candidate = adaptMaterialCourseFullPackage(snapshot, { deadlineAt: null });
  const requests: MaterialSourceLocatorRequest[] = [
    ...pack.questions.map(q => ({ kind: "question" as const, questionId: q.id })),
    ...pack.skills.map(s => ({ kind: "skill" as const, skillId: s.id })),
  ];
  // Materialize before calling a trusted dependency: returned locations cannot observe
  // mutation of caller input or the verifier's private candidate/payload references.
  const sources = requests.map(request => locator.resolve(request));
  const assessment = assessMaterialCoursePackageReadiness(candidate, captured.bindings, isolatedAuthority);
  const locations = sources.flatMap(source => source.locations);
  const unboundLocations = locations.filter(location => location.status === "unbound").length;
  const readyCount = (capability: "diagnostic" | "scoring" | "bkt") =>
    assessment.questions.filter(q => q[capability].status === "ready").length;
  return {
    kind: "material_author_readiness_model" as const,
    context: "private_author_review_only" as const,
    moduleStatus: "MODULE_PENDING" as const,
    layers: {
      preview: { ...assessment.preview, runtimeReady: false as const },
      sources: {
        status: "available" as const, locations: locations.length,
        locatedLocations: locations.length - unboundLocations, unboundLocations,
        blockers: [
          ...(unboundLocations ? ["explicit_host_source_bindings_missing"] : []),
          "host_pdf_bytes_and_access_not_verified", "source_location_is_not_question_identity_or_family",
        ],
      },
      // These statuses describe contracts assessed at this call only, not execution.
      domain: assessment,
      execution: {
        status: "not_ready" as const, runtimeReady: false as const,
        blockers: ["MODULE_PENDING", "host_producer_not_implemented", "execution_boundary_revalidation_required"],
        contractReadyQuestions: { diagnostic: readyCount("diagnostic"), scoring: readyCount("scoring"), bkt: readyCount("bkt") },
        executedQuestions: 0 as const,
      },
    },
    sources,
    permissions: {
      ...assessment.permissions,
      diagnosticExecutionAuthorized: false as const, firstAnswerAuthorized: false as const,
      helpRecorded: false as const, exposureRecorded: false as const,
    },
  };
}

export type MaterialAuthorReadinessModel = ReturnType<typeof readMaterialAuthorReadiness>;
