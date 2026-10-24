import { describe, expect, it, vi } from "vitest";
import { TransitionLink } from "../v3/motion/view-transition";
import { ShellNavLink } from "./shell-nav-link";

describe("ShellNavLink soft navigation", () => {
  it("delegates internal navigation to the transition-aware Next Link", () => {
    const node = ShellNavLink({ href: "/opening/assistant", children: "助理" });
    expect(node.type).toBe(TransitionLink);
    expect(node.props.href).toBe("/opening/assistant");
    expect(node.props.onClick).toBeUndefined();
  });

  it("forwards query/hash targets and new-tab attributes", () => {
    const node = ShellNavLink({ href: "/opening/library?tab=notes#recent", target: "_blank", rel: "noopener", "aria-current": "page" });
    expect(node.props).toMatchObject({ href: "/opening/library?tab=notes#recent", target: "_blank", rel: "noopener", "aria-current": "page" });
  });

  it("forwards the caller click handler including cancellation", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const node = ShellNavLink({ href: "/opening/courses", onClick });
    expect(node.props.onClick).toBe(onClick);
    const preventDefault = vi.fn();
    node.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

});
