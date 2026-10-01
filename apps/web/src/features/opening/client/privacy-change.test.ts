import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyOpeningPrivacyChange, subscribeOpeningPrivacyChange } from "./privacy-change";

class TestChannel {
  static instances: TestChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(readonly name: string) { TestChannel.instances.push(this); }
  receive(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
}
const dispose: Array<() => void> = [];
function subscribe(listener: () => void) {
  const cancel = subscribeOpeningPrivacyChange(listener); dispose.push(cancel); return cancel;
}
afterEach(() => { dispose.splice(0).forEach(cancel => cancel()); vi.unstubAllGlobals(); TestChannel.instances = []; });

describe("content-free opening privacy notifications", () => {
  it("delivers once locally and sends only the fixed signal to other tabs", () => {
    vi.stubGlobal("window", { BroadcastChannel: TestChannel });
    const listener = vi.fn(); subscribe(listener);
    notifyOpeningPrivacyChange();
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    expect(TestChannel.instances).toHaveLength(1);
    expect(TestChannel.instances[0]!.name).toBe("aistudy:opening-privacy-change");
    expect(TestChannel.instances[0]!.postMessage).toHaveBeenCalledExactlyOnceWith("changed");
  });
  it("accepts a remote fixed signal without rebroadcasting and ignores other payloads", () => {
    vi.stubGlobal("window", { BroadcastChannel: TestChannel });
    const listener = vi.fn(); subscribe(listener);
    const channel = TestChannel.instances[0]!;
    channel.receive({ type: "changed", sourceId: "private-source" }); channel.receive("unknown");
    expect(listener).not.toHaveBeenCalled();
    channel.receive("changed");
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    expect(channel.postMessage).not.toHaveBeenCalled();
  });
  it("keeps local delivery when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("window", {});
    const listener = vi.fn(); subscribe(listener); notifyOpeningPrivacyChange();
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    expect(TestChannel.instances).toHaveLength(0);
  });
  it("keeps local delivery when a browser denies channel creation", () => {
    vi.stubGlobal("window", { BroadcastChannel: class { constructor() { throw new Error("blocked"); } } });
    const listener = vi.fn(); subscribe(listener);
    expect(() => notifyOpeningPrivacyChange()).not.toThrow();
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });
  it("does not report a committed action as failed if cross-tab posting fails", () => {
    vi.stubGlobal("window", { BroadcastChannel: TestChannel });
    const listener = vi.fn(); subscribe(listener);
    TestChannel.instances[0]!.postMessage.mockImplementation(() => { throw new Error("transport closed"); });
    expect(() => notifyOpeningPrivacyChange()).not.toThrow();
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });
  it("detaches old listeners and closed channel callbacks without disabling a new scope", () => {
    vi.stubGlobal("window", { BroadcastChannel: TestChannel });
    const old = vi.fn(), other = vi.fn(), current = vi.fn();
    const stopOld = subscribe(old), stopOther = subscribe(other);
    const first = TestChannel.instances[0]!, staleMessage = first.onmessage!;
    stopOld(); first.receive("changed");
    expect(old).not.toHaveBeenCalled(); expect(other).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    stopOther(); expect(first.close).toHaveBeenCalledTimes(1);
    subscribe(current); stopOld();
    staleMessage(new MessageEvent("message", { data: "changed" }));
    expect(current).not.toHaveBeenCalled();
    TestChannel.instances[1]!.receive("changed");
    expect(current).toHaveBeenCalledExactlyOnceWith();
  });
  it("closes a send-only channel when the acting tab has no history listener", () => {
    vi.stubGlobal("window", { BroadcastChannel: TestChannel });
    notifyOpeningPrivacyChange();
    const channel = TestChannel.instances[0]!;
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith("changed");
    expect(channel.close).toHaveBeenCalledTimes(1);
  });
});
