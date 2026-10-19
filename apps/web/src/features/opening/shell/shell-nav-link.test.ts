import { describe, expect, it, vi } from "vitest";
import { ShellNavLink } from "./shell-nav-link";

describe("ShellNavLink native navigation", () => {
  it("renders a native anchor, not an intercepted Next Link", () => {
    const node = ShellNavLink({ href: "/opening/assistant", children: "助理" });
    expect(node.type).toBe("a");
    expect(node.props.href).toBe("/opening/assistant");
    expect(node.props.onClick).toBeUndefined();
  });

  it("preserves exact query/hash targets and native new-tab semantics", () => {
    const node = ShellNavLink({ href: "/opening/library?tab=notes#recent", target: "_blank", rel: "noopener", "aria-current": "page" });
    expect(node.props).toMatchObject({ href: "/opening/library?tab=notes#recent", target: "_blank", rel: "noopener", "aria-current": "page" });
  });

  it("preserves caller cancellation and mobile menu closing without timers", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const node = ShellNavLink({ href: "/opening/courses", onClick });
    expect(node.props.onClick).toBe(onClick);
    const preventDefault = vi.fn();
    node.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("has no shared or per-link delayed redirect to race later clicks", () => {
    const setTimeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const first = ShellNavLink({ href: "/opening/courses" });
      const second = ShellNavLink({ href: "/opening/assistant" });
      expect(first.props.onClick).toBeUndefined();
      expect(second.props.onClick).toBeUndefined();
      expect(setTimeout).not.toHaveBeenCalled();
    } finally { setTimeout.mockRestore(); }
  });
});
