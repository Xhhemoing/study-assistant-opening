import { portableMarkdownNoteSchema, type ObsidianLink, type PortableMarkdownNote } from "@aistudy/contracts/learner-portability";

function obsidianLinks(markdown: string): ObsidianLink[] {
  const links: ObsidianLink[] = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line);
    if (marker && !fence) fence = marker[1];
    else if (marker && fence && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
    else if (!fence) {
      const tokens = /\\.|(`+).*?\1|(!?)\[\[([^\]\r\n]+)\]\]/gu;
      for (const match of line.matchAll(tokens)) {
        if (!match[3]) continue;
        const pipe = match[3].indexOf("|");
        const destination = pipe < 0 ? match[3] : match[3].slice(0, pipe);
        const hash = destination.indexOf("#");
        const target = hash < 0 ? destination : destination.slice(0, hash);
        const fragment = hash < 0 ? null : destination.slice(hash + 1);
        if (!target && !fragment) continue;
        links.push({
          target, fragment,
          alias: pipe < 0 ? null : match[3].slice(pipe + 1),
          embed: match[2] === "!", offset: offset + match.index,
        });
      }
    }
    offset += line.length;
  }
  return links;
}

export function importMarkdown(path: string, markdown: string): PortableMarkdownNote {
  return portableMarkdownNoteSchema.parse({ path, format: "markdown", markdown, links: [] });
}

export function importObsidianNote(path: string, markdown: string): PortableMarkdownNote {
  return portableMarkdownNoteSchema.parse({ path, format: "obsidian", markdown, links: obsidianLinks(markdown) });
}

export function exportMarkdown(note: PortableMarkdownNote): string {
  return portableMarkdownNoteSchema.parse(note).markdown;
}

export function exportObsidianNote(note: PortableMarkdownNote): { path: string; markdown: string } {
  const { path, markdown } = portableMarkdownNoteSchema.parse(note);
  return { path, markdown };
}
