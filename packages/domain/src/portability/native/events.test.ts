import { expect, it } from "vitest";
import { retainBackupEventChains } from "./events";

it.each(["correctsEventId", "corrects_event_id"] as const)(
  "keeps only rooted correction chains for %s and orders them for restore",
  key => {
    const events = [
      { id: "c2", type: "correction", [key]: "c1" },
      { id: "orphan2", type: "correction", [key]: "orphan1" },
      { id: "loop1", type: "correction", [key]: "loop2" },
      { id: "c1", type: "correction", [key]: "review" },
      { id: "orphan1", type: "correction", [key]: "excluded" },
      { id: "loop2", type: "correction", [key]: "loop1" },
      { id: "review", type: "review", [key]: null },
      { id: "unlinked", type: "correction", [key]: null },
    ];
    expect(retainBackupEventChains(events, key).map(event => event.id)).toEqual(["review", "c1", "c2"]);
  },
);
