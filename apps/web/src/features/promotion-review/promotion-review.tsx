"use client";

import { Check, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  PromotionCandidateKind,
  PromotionRecord,
} from "@aistudy/contracts";
import { PromotionApi } from "./promotion-api";

const candidateKinds: PromotionCandidateKind[] = [
  "note",
  "card",
  "question",
  "task",
];

export function PromotionReview({ explorationId }: { explorationId: string }) {
  const [items, setItems] = useState<PromotionRecord[]>([]);
  const [kind, setKind] = useState<PromotionCandidateKind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    PromotionApi.list(explorationId)
      .then(setItems)
      .catch((reason) => setError(reason.message));
  }, [explorationId]);

  async function createCandidate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await PromotionApi.create(explorationId, {
        kind,
        title,
        body,
      });
      setItems((current) => [...current, created]);
      setTitle("");
      setBody("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(item: PromotionRecord, action: "accept" | "reject") {
    setBusy(true);
    try {
      const updated = await PromotionApi[action](item.id);
      setItems((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Exploration promotion
        </p>
        <h1 className="text-2xl font-semibold text-slate-950">
          Review candidates
        </h1>
      </div>
      <form
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4"
        onSubmit={createCandidate}
      >
        <select
          aria-label="Candidate type"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as PromotionCandidateKind)
          }
        >
          {candidateKinds.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          aria-label="Candidate title"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          maxLength={200}
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Candidate body"
          className="min-h-24 rounded-md border border-slate-300 px-3 py-2 text-sm"
          maxLength={20000}
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button
          className="w-fit rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          Create candidate
        </button>
      </form>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </p>
      )}
      {items.map((item) => (
        <article
          key={item.id}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-medium text-slate-950">{item.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{item.body}</p>
              <p className="mt-2 text-xs text-slate-500">
                {item.kind} · {item.status} · source {item.explorationId}
              </p>
            </div>
            {item.status === "pending" && (
              <div className="flex gap-2">
                <button
                  aria-label="Accept candidate"
                  className="rounded-md border border-emerald-200 p-2 text-emerald-700 hover:bg-emerald-50"
                  disabled={busy}
                  onClick={() => decide(item, "accept")}
                  title="Accept candidate"
                  type="button"
                >
                  <Check size={16} />
                </button>
                <button
                  aria-label="Reject candidate"
                  className="rounded-md border border-rose-200 p-2 text-rose-700 hover:bg-rose-50"
                  disabled={busy}
                  onClick={() => decide(item, "reject")}
                  title="Reject candidate"
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {item.status === "accepted" && item.targetType === "document" && (
              <a
                className="inline-flex items-center gap-1 text-sm text-blue-700 underline"
                href={`/library/${item.targetId}`}
              >
                <FileText size={16} />
                Open note
              </a>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
