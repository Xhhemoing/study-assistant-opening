"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { createSessionFetch } from "../../auth/session-expiry";

const countSchema = z.object({ count: z.number().int().nonnegative() });

/** Metadata only: listing the review queue here would deliver card content and record exposure. */
export function useDueReviewCount(pathname: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const response = await createSessionFetch()("/api/reviews/count", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Review count unavailable");
        const body = countSchema.parse(await response.json());
        if (!request.signal.aborted) setCount(body.count);
      } catch {
        if (!request.signal.aborted) setCount(null);
      }
    };
    void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("opening:reviews-changed", refresh);
      window.addEventListener("focus", refresh);
    }
    return () => {
      controller?.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener("opening:reviews-changed", refresh);
        window.removeEventListener("focus", refresh);
      }
    };
  }, [pathname]);
  return count;
}
