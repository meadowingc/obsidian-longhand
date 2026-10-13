import { GFM, parser } from "@lezer/markdown";

export interface TextCleanupResult {
  text: string;
  removedCount: number;
}

const markdownParser = parser.configure(GFM);
const removableCharacters = /[\u00AD\u200B\u2060\uFEFF]/;
const protectedNodes = new Set([
  "CodeBlock", "FencedCode", "InlineCode",
  "Link", "Image", "Autolink", "LinkReference", "URL",
  "HTMLBlock", "HTMLTag", "Comment", "CommentBlock", "ProcessingInstructionBlock",
]);

export function cleanInvisibleCharacters(text: string): TextCleanupResult {
  if (!removableCharacters.test(text)) return { text, removedCount: 0 };
  const ranges: { from: number; to: number }[] = [];
  let offset = text.startsWith("\uFEFF") ? 1 : 0;
  const opening = /^---[ \t]*\r?\n/.exec(text.slice(offset));
  if (opening) {
    const bodyStart = offset + opening[0].length;
    const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(text.slice(bodyStart));
    // An unfinished frontmatter block may still contain exact user data.
    if (!closing) return { text, removedCount: 0 };
    offset = bodyStart + closing.index + closing[0].length;
    ranges.push({ from: 0, to: offset });
  }

  markdownParser.parse(text.slice(offset)).iterate({
    enter(node) {
      if (!protectedNodes.has(node.name)) return;
      ranges.push({ from: offset + node.from, to: offset + node.to });
      return false;
    },
  });

  // Obsidian's wiki links are not part of standard Markdown.
  for (const match of text.matchAll(/!?\[\[[^\r\n]*?\]\]/g)) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);

  let removedCount = 0;
  const deletionPattern = new RegExp(removableCharacters, "g");
  const cleanProse = (prose: string) => prose.replace(deletionPattern, () => {
    removedCount++;
    return "";
  });
  let cursor = 0;
  let cleaned = "";
  for (const range of ranges) {
    if (range.to <= cursor) continue;
    if (range.from > cursor) cleaned += cleanProse(text.slice(cursor, range.from));
    cleaned += text.slice(Math.max(cursor, range.from), range.to);
    cursor = range.to;
  }
  cleaned += cleanProse(text.slice(cursor));
  return { text: cleaned, removedCount };
}
