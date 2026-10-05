import { describe, expect, it } from "vitest";
import {
  buildTutorActions,
  parseTutorActionsSearchParams,
} from "./tutor-actions";

const COURSE = "11111111-1111-4111-8111-111111111111";

describe("K02a tutor-actions", () => {
  it("returns guided from page/skillLabel without nodeId or evidence", () => {
    const actions = buildTutorActions({
      skillLabel: "derivatives",
      currentPage: 5,
      nodeId: null,
      sourceIds: [],
      sessionExposures: [],
      assistedSuccessOnCurrentItem: false,
      retestDue: false,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("guided");
    expect(actions[0]!.nodeId).toBeNull();
    expect(actions[0]).not.toHaveProperty("masteryPercent");
  });

  it("parses query and recommends independent_variant after assisted success", () => {
    const params = new URLSearchParams({
      skillLabel: "chain rule",
      currentPage: "2",
      problemRef: "item-A",
      assistedSuccess: "1",
    });
    const parsed = parseTutorActionsSearchParams(COURSE, params);
    const actions = buildTutorActions({
      skillLabel: parsed.query.skillLabel,
      currentPage: parsed.query.currentPage ?? null,
      problemRef: parsed.query.problemRef ?? null,
      sourceIds: parsed.sourceIds,
      sessionExposures: parsed.sessionExposures,
      assistedSuccessOnCurrentItem: Boolean(parsed.query.assistedSuccess),
      retestDue: Boolean(parsed.query.retestDue),
    });
    expect(actions[0]!.kind).toBe("independent_variant");
    expect(actions[0]!.problemRef).not.toBe("item-A");
  });
});
