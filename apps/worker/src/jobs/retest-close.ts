import type { Scope, SkillEvidence } from "@aistudy/contracts";
import {
  nextTutorKindAfterRetestClose,
  prepareRetestSkillLink,
  shouldAppendRetestEvidence,
  type AdaptiveTutorActionKind,
  type RetestCloseAssistance,
  type RetestCloseDimension,
  type RetestCloseOutcome,
} from "@aistudy/domain";

export type RetestCloseLinkRecord = {
  id: string;
  nodeId: string;
  observationId: string;
  dimension: SkillEvidence["dimension"];
};

export type RetestCloseInput = {
  observationId: string;
  courseId: string;
  skillLabel: string;
  retestId: string;
  assistance: RetestCloseAssistance;
  outcome: RetestCloseOutcome;
  nodeId?: string | null;
  dimension?: RetestCloseDimension | null;
};

export type RetestCloseDeps = {
  link(
    scope: Scope,
    input: {
      nodeId: string;
      observationId: string;
      dimension: SkillEvidence["dimension"];
      courseId?: string;
    },
  ): Promise<RetestCloseLinkRecord>;
  getSnapshot(
    scope: Scope,
    courseId: string,
  ): Promise<{ nodes: ReadonlyArray<{ id: string; label: string }> } | null>;
  /** Ensure the retest activity/task is no longer due (idempotent). */
  ensureDueCleared(scope: Scope, retestId: string): Promise<{ dueCleared: boolean }>;
  listByObservation?(
    scope: Scope,
    observationId: string,
  ): Promise<ReadonlyArray<{ id: string; nodeId: string }>>;
};

export type RetestCloseResult = {
  linked: RetestCloseLinkRecord | null;
  dueCleared: boolean;
  skippedReason?: "assisted_or_unverified" | "no_node" | "already_linked";
  nextKind: AdaptiveTutorActionKind | null;
};

/**
 * L02 retest completion (K02): clear due + append SkillEvidence via Data `link`.
 * Does not rewrite DL3 enqueue or DL6 grading — only projection + due clear.
 */
export function createRetestCloseHandler(deps: RetestCloseDeps) {
  return async function closeRetestWithEvidence(
    scope: Scope,
    input: RetestCloseInput,
  ): Promise<RetestCloseResult> {
    const { dueCleared } = await deps.ensureDueCleared(scope, input.retestId);

    if (!shouldAppendRetestEvidence(input)) {
      return {
        linked: null,
        dueCleared,
        skippedReason: "assisted_or_unverified",
        nextKind: null,
      };
    }

    const existing = deps.listByObservation
      ? await deps.listByObservation(scope, input.observationId)
      : [];
    if (existing.length > 0) {
      const nodeId = existing[0]!.nodeId;
      return {
        linked: null,
        dueCleared,
        skippedReason: "already_linked",
        nextKind: nextTutorKindAfterRetestClose(nodeId),
      };
    }

    const snapshot = await deps.getSnapshot(scope, input.courseId);
    const fields = prepareRetestSkillLink({
      retestId: input.retestId,
      assistance: input.assistance,
      outcome: input.outcome,
      skillLabel: input.skillLabel,
      nodeId: input.nodeId,
      dimension: input.dimension,
      snapshot,
    });
    if (!fields) {
      return {
        linked: null,
        dueCleared,
        skippedReason: "no_node",
        nextKind: null,
      };
    }

    const linked = await deps.link(scope, {
      nodeId: fields.nodeId,
      observationId: input.observationId,
      dimension: fields.dimension,
      courseId: input.courseId,
    });

    return {
      linked,
      dueCleared,
      nextKind: nextTutorKindAfterRetestClose(fields.nodeId),
    };
  };
}
