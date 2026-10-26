import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ permanentRedirect: (href: string) => { throw new Error(href); } }));
import PlanningPage from "../../app/(opening)/opening/settings/planning/page";
import AdvancedPage from "../../app/(opening)/opening/settings/advanced/page";

it("permanently redirects old settings routes without dropping task or repeated query values", async () => {
  await expect(PlanningPage({ searchParams: Promise.resolve({ task: "task-a", tag: ["a", "b"] }) }))
    .rejects.toThrow("/opening/settings/learning?task=task-a&tag=a&tag=b&planning=1");
  await expect(AdvancedPage({ searchParams: Promise.resolve({ model: "model-a" }) }))
    .rejects.toThrow("/opening/settings/ai?model=model-a");
});
