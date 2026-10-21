import { useCallback, useEffect, useRef } from "react";
import { recordLearningExperience } from "../client/learning-experience";
type Target = { targetType: "activity" | "course" | "conversation"; targetId: string };

/** Only a visible primary suggestion enters the denominator; clicks are ordered after that receipt. */
export function useNextStepMetrics(target: Target | null) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const shown = useRef<Promise<boolean> | null>(null);
  const type = target?.targetType, id = target?.targetId;
  useEffect(() => {
    visible.current = false; shown.current = null;
    if (!type || !id || !ref.current || typeof IntersectionObserver === "undefined") return;
    const observeVisible = () => {
      if (!visible.current || document.hidden || shown.current) return;
      shown.current = recordLearningExperience({ kind: "next_step_shown", targetType: type, targetId: id });
    };
    const observer = new IntersectionObserver(entries => {
      visible.current = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5);
      observeVisible();
    }, { threshold: 0.5 });
    observer.observe(ref.current.querySelector('[data-today-primary-cta="true"]') ?? ref.current);
    document.addEventListener("visibilitychange", observeVisible);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", observeVisible); };
  }, [type, id]);
  const clicked = useCallback(() => {
    if (!type || !id || !visible.current || document.hidden) return;
    // Refresh the same-day exposure at a midnight crossing; server keys deduplicate ordinary clicks.
    void recordLearningExperience({ kind: "next_step_shown", targetType: type, targetId: id }).then(ok => {
      if (ok) return recordLearningExperience({ kind: "next_step_started", targetType: type, targetId: id });
    });
  }, [type, id]);
  return { ref, clicked };
}
