import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyOpeningPrivacyChange, subscribeOpeningPrivacyChange } from "./privacy-change";

/** Transport port only: this does not simulate browser permission enforcement. */
class ChannelPort {
  static instances: ChannelPort[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  closed = 0;
  constructor(readonly name: string) { ChannelPort.instances.push(this); }
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed++; }
}
const cancellations: Array<() => void> = [];
function subscribe(listener: () => void) {
  const stop = subscribeOpeningPrivacyChange(listener); cancellations.push(stop); return stop;
}
afterEach(() => { cancellations.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); ChannelPort.instances = []; });

describe("privacy invalidation stays content-free across retained history subscriptions (pure transport port)", () => {
  it.each([null, undefined, false, 1, ["changed"], { type: "changed", answer: "SYNTHETIC_PRIVATE_ANSWER" }, "CHANGED", "changed "])(
    "ignores non-protocol remote input %j without rebroadcast or history invalidation", payload => {
      vi.stubGlobal("window", { BroadcastChannel: ChannelPort });
      const listener = vi.fn(); subscribe(listener);
      const channel = ChannelPort.instances[0]!;
      channel.onmessage!({ data: payload });
      expect(listener).not.toHaveBeenCalled(); expect(channel.sent).toEqual([]);
    });

  it("independent subscriptions of the same history callback retain separate lifetimes", () => {
    vi.stubGlobal("window", { BroadcastChannel: ChannelPort });
    const listener = vi.fn(), stopFirst = subscribe(listener); subscribe(listener);
    const channel = ChannelPort.instances[0]!;
    stopFirst(); stopFirst(); channel.onmessage!({ data: "changed" });
    expect(listener).toHaveBeenCalledExactlyOnceWith(); expect(channel.closed).toBe(0);
  });

  it("closing a history scope makes all captured old callbacks inert after reopen", () => {
    vi.stubGlobal("window", { BroadcastChannel: ChannelPort });
    const oldHistory = vi.fn(), stop = subscribe(oldHistory);
    const first = ChannelPort.instances[0]!, stale = first.onmessage!;
    stop(); const newHistory = vi.fn(); subscribe(newHistory);
    const current = ChannelPort.instances[1]!;
    stale({ data: "changed" }); stale({ data: { answer: "SYNTHETIC_PRIVATE_ANSWER" } });
    expect(oldHistory).not.toHaveBeenCalled(); expect(newHistory).not.toHaveBeenCalled();
    current.onmessage!({ data: "changed" });
    expect(newHistory).toHaveBeenCalledExactlyOnceWith(); expect(current.sent).toEqual([]);
  });

  it("send-only notifications never keep a retained cross-scope transport alive", () => {
    vi.stubGlobal("window", { BroadcastChannel: ChannelPort });
    notifyOpeningPrivacyChange(); notifyOpeningPrivacyChange();
    expect(ChannelPort.instances).toHaveLength(2);
    for (const channel of ChannelPort.instances) {
      expect(channel.sent).toEqual(["changed"]); expect(channel.closed).toBe(1); expect(channel.onmessage).toBeNull();
    }
  });

  it("local withdrawal still invalidates history in a server/no-window environment", () => {
    vi.stubGlobal("window", undefined);
    const listener = vi.fn(); subscribe(listener); notifyOpeningPrivacyChange();
    expect(listener).toHaveBeenCalledExactlyOnceWith(); expect(ChannelPort.instances).toEqual([]);
  });
});
