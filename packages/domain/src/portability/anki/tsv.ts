import type { AnkiNote } from "@aistudy/contracts";

export function serializeAnkiTsv(notes: AnkiNote[]): string {
  const header = ["Front", "Back", "Source", "Tags"];
  const rows = notes.map((note) => [
    note.fields.Front,
    note.fields.Back,
    note.fields.Source,
    note.tags.join(" "),
  ]);
  return [header, ...rows].map((row) => row.map(escapeCell).join("\t")).join("\n");
}

function escapeCell(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", "<br>");
}
