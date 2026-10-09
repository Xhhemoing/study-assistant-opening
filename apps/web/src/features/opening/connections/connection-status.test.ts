import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATE_LABEL,
  connectionErrorCopy,
  connectionStateLabel,
  formatLastSyncAt,
  isConnectionUnavailable,
  shouldClearSecretAfterSubmit,
} from "./connection-status";

describe("connection-status", () => {
  it("labels needs_authorization as 等待授权 for U04 e2e", () => {
    expect(connectionStateLabel("needs_authorization")).toBe("等待授权");
    expect(CONNECTION_STATE_LABEL.needs_authorization).toBe("等待授权");
  });

  it("formats sync time and errors without inventing success", () => {
    expect(formatLastSyncAt(null)).toBe("尚未成功同步");
    expect(formatLastSyncAt("2026-10-09T10:00:00.000Z")).toMatch(/2026/);
    expect(connectionErrorCopy({ state: "ready", errorCode: "X" })).toBeNull();
    expect(connectionErrorCopy({ state: "error", errorCode: "TLS" })).toContain("TLS");
  });

  it("treats revoked and disabled as unavailable for sync controls", () => {
    expect(isConnectionUnavailable({ state: "revoked" })).toBe(true);
    expect(isConnectionUnavailable({ state: "disabled" })).toBe(true);
    expect(isConnectionUnavailable({ state: "ready" })).toBe(false);
  });

  it("clears secrets after successful secure submit", () => {
    expect(shouldClearSecretAfterSubmit(true)).toBe(true);
    expect(shouldClearSecretAfterSubmit(false)).toBe(false);
  });
});
