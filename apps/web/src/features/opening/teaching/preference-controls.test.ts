import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENING_INTERVENTION_PREFS,
  type InterventionSettingsResponse,
} from "@aistudy/contracts";
import {
  PreferenceControls,
  PreferenceControlsView,
  winningLayer,
  winningLayerLabel,
} from "./preference-controls";
import {
  DEFAULT_INTERVENTION_UI_DECISION_CONTEXT,
  INTERVENTION_DECISION_PERSIST_SOFT_GAP,
  clearProactiveRejects,
  withProactiveReject,
  withUserTyping,
} from "./intervention-decision-context";

const baseResponse = (): InterventionSettingsResponse => ({
  settings: { ...DEFAULT_OPENING_INTERVENTION_PREFS },
  courseOverride: null,
  sessionOverride: null,
  effective: { ...DEFAULT_OPENING_INTERVENTION_PREFS },
  saved: true,
  invalidStoredSettings: false,
});

describe("winningLayer", () => {
  it("reports session > course > global", () => {
    expect(winningLayer(baseResponse())).toBe("global");
    expect(winningLayerLabel("global")).toContain("全局");

    const course = {
      ...baseResponse(),
      courseOverride: { quietMode: true },
      effective: { ...DEFAULT_OPENING_INTERVENTION_PREFS, quietMode: true },
    };
    expect(winningLayer(course)).toBe("course");

    const session = {
      ...course,
      sessionOverride: { proactivity: "off" as const },
      effective: {
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        quietMode: true,
        proactivity: "off" as const,
      },
    };
    expect(winningLayer(session)).toBe("session");
    expect(winningLayerLabel("session")).toContain("临时");
  });
});

describe("intervention decision context helpers", () => {
  it("tracks typing and consecutive rejects locally", () => {
    let ctx = DEFAULT_INTERVENTION_UI_DECISION_CONTEXT;
    ctx = withUserTyping(ctx, true);
    expect(ctx.userIsTyping).toBe(true);
    ctx = withProactiveReject(ctx);
    ctx = withProactiveReject(ctx);
    expect(ctx.consecutiveProactiveRejects).toBe(2);
    ctx = clearProactiveRejects(ctx);
    expect(ctx.consecutiveProactiveRejects).toBe(0);
    expect(INTERVENTION_DECISION_PERSIST_SOFT_GAP).toMatch(/appendDecision/);
  });
});

describe("PreferenceControlsView", () => {
  it("shows effective layer, session≠permanent banner, reset, and forbids nag/dwell UI", () => {
    const data: InterventionSettingsResponse = {
      ...baseResponse(),
      sessionOverride: { quietMode: true },
      effective: { ...DEFAULT_OPENING_INTERVENTION_PREFS, quietMode: true },
    };
    const html = renderToStaticMarkup(
      createElement(PreferenceControlsView, {
        scope: "global",
        data,
        draft: data.settings,
        busy: false,
        decisionCtx: DEFAULT_INTERVENTION_UI_DECISION_CONTEXT,
        onDraftChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        onReload: () => undefined,
        onTyping: () => undefined,
        onRejectOffer: () => undefined,
        onClearRejects: () => undefined,
      }),
    );
    expect(html).toContain('data-preference-controls="true"');
    expect(html).toContain('data-winning-layer="session"');
    expect(html).toContain("data-session-temp-banner");
    expect(html).toContain("不会写回全局或课程永久设置");
    expect(html).toContain("本课临时覆盖（优先）");
    expect(html).toContain("安静模式");
    expect(html).toContain("保存介入偏好");
    expect(html).toContain("重置为默认");
    expect(html).toContain("求助不等于打断");
    expect(html).toContain('data-intervention-typing="true"');
    expect(html).toContain('data-intervention-reject="true"');
    expect(html).toContain('data-no-nag-interval="true"');
    expect(html).toContain('data-no-dwell-stuck="true"');
    expect(html).toContain("appendDecision");
    expect(html).not.toMatch(/\bmustAskEvery\b|\bintervalMinutes\b|\bdwellStuck\b/);
    expect(html).not.toMatch(/type="number"[^>]*nag|nag-interval-input/);
  });

  it("labels session scope save/clear distinctly from permanent", () => {
    const data = baseResponse();
    const html = renderToStaticMarkup(
      createElement(PreferenceControlsView, {
        scope: "session",
        compact: true,
        data,
        draft: data.effective,
        busy: false,
        decisionCtx: withUserTyping(DEFAULT_INTERVENTION_UI_DECISION_CONTEXT, true),
        onDraftChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        onReload: () => undefined,
        onTyping: () => undefined,
        onRejectOffer: () => undefined,
        onClearRejects: () => undefined,
      }),
    );
    expect(html).toContain('data-intervention-scope="session"');
    expect(html).toContain("保存本课临时");
    expect(html).toContain("清除本课临时");
    expect(html).toContain("与永久设置分开保存");
    expect(html).toContain("打字中");
  });
});

describe("PreferenceControls container", () => {
  it("requires activityId for session scope", () => {
    const html = renderToStaticMarkup(
      createElement(PreferenceControls, { scope: "session", activityId: null }),
    );
    expect(html).toContain('data-intervention-session-missing="true"');
    expect(html).toContain("无教学活动时无法设置本课临时偏好");
  });

  it("SSR loading shell carries soft-gap and no-nag markers", () => {
    const html = renderToStaticMarkup(
      createElement(PreferenceControls, {
        scope: "global",
        api: {
          getInterventionSettings: vi.fn(async () => baseResponse()),
          putInterventionSettings: vi.fn(),
        } as never,
      }),
    );
    expect(html).toContain('data-preference-controls="true"');
    expect(html).toContain("正在读取介入偏好");
    expect(html).toContain("data-decision-persist-gap");
    expect(html).toContain('data-no-nag-interval="true"');
  });
});
