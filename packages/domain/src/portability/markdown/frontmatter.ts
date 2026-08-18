import type { PortableDocument, PortableSourceFile } from "./types";

export function serializeFrontmatter(document: PortableDocument): string {
  const lines = [
    "---",
    `id: ${document.id}`,
    `title: ${formatScalar(document.title)}`,
    serializeList("tags", document.tags),
    serializeSourceFiles(document.sourceFiles),
    "---",
  ];
  return lines.join("\n");
}

function serializeList(key: string, values: string[]): string {
  if (values.length === 0) return `${key}: []`;
  return `${key}:\n${values.map((value) => `  - ${formatScalar(value)}`).join("\n")}`;
}

function serializeSourceFiles(files: PortableSourceFile[]): string {
  if (files.length === 0) return "sourceFiles: []";
  const items = files.map((file) => {
    const pathLine = `  - path: ${formatScalar(file.path)}`;
    if (!file.mediaType) return pathLine;
    return `${pathLine}\n    mediaType: ${formatScalar(file.mediaType)}`;
  });
  return `sourceFiles:\n${items.join("\n")}`;
}

function formatScalar(value: string): string {
  if (value === "" || /[:#{}[\],&*?]|^\s|\s$/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export type ParsedFrontmatter = {
  id: string;
  title: string;
  tags: string[];
  sourceFiles: PortableSourceFile[];
};

export function parseFrontmatter(markdown: string): { meta: ParsedFrontmatter; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      meta: { id: "imported-document", title: "Untitled", tags: [], sourceFiles: [] },
      body: markdown,
    };
  }
  return {
    meta: parseFrontmatterBody(match[1] ?? ""),
    body: markdown.slice(match[0].length),
  };
}

function parseFrontmatterBody(raw: string): ParsedFrontmatter {
  const meta: ParsedFrontmatter = { id: "imported-document", title: "Untitled", tags: [], sourceFiles: [] };
  let mode: "root" | "tags" | "sourceFiles" = "root";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const keyMatch = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      mode = "root";
      const key = keyMatch[1];
      const rest = (keyMatch[2] ?? "").trim();
      if (key === "id") meta.id = unquote(rest);
      else if (key === "title") meta.title = unquote(rest);
      else if (key === "tags") {
        mode = "tags";
        if (rest === "[]") meta.tags = [];
      } else if (key === "sourceFiles") {
        mode = "sourceFiles";
        if (rest === "[]") meta.sourceFiles = [];
      }
      continue;
    }
    if (mode === "tags") {
      const item = line.match(/^\s*-\s+(.*)$/);
      if (item) meta.tags.push(unquote(item[1] ?? ""));
      continue;
    }
    if (mode === "sourceFiles") {
      const pathItem = line.match(/^\s*-\s+path:\s+(.*)$/);
      if (pathItem) {
        meta.sourceFiles.push({ path: unquote(pathItem[1] ?? "") });
        continue;
      }
      const stringItem = line.match(/^\s*-\s+(.*)$/);
      if (stringItem) {
        meta.sourceFiles.push({ path: unquote(stringItem[1] ?? "") });
        continue;
      }
      const media = line.match(/^\s+mediaType:\s+(.*)$/);
      const last = meta.sourceFiles.at(-1);
      if (media && last) last.mediaType = unquote(media[1] ?? "");
    }
  }
  return meta;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.replaceAll("'", "\"")) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
