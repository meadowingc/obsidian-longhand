// Service: wikilinkEntities
// Adds wikilinks for first occurrence of existing note names (and frontmatter aliases) in provided text.
// Rules:
// - Case-insensitive match
// - Only first occurrence per canonical note
// - Prefer longest entity names first (to avoid partial overlaps)
// - Preserve original casing via piped alias if different from canonical
// - Skip current file (no self-link) and existing wikilinks
// - Avoid linking inside existing [[...]] ranges
import { App, TFile } from "obsidian";

/**
 * Escape a string for safe use in a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect entity map:
 *  key: lowercased alias or basename
 *  value: canonical basename (without extension)
 */
function buildEntityMap(app: App, current: TFile): Map<string, string> {
  const map = new Map<string, string>();
  const notes = app.vault.getMarkdownFiles();

  for (const f of notes) {
    if (f.path === current.path) continue; // skip self
    const canonical = f.basename;
    const canonicalLower = canonical.toLowerCase();
    if (!map.has(canonicalLower)) {
      map.set(canonicalLower, canonical);
    }

    const cache = app.metadataCache.getFileCache(f);
    const fm: any = cache?.frontmatter;
    if (fm) {
      let aliases: string[] = [];
      if (typeof fm.aliases === "string") {
        aliases = [fm.aliases];
      } else if (Array.isArray(fm.aliases)) {
        aliases = fm.aliases.filter((x: any) => typeof x === "string");
      }
      for (const al of aliases) {
        const trimmed = al.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (!map.has(lower)) {
          map.set(lower, canonical);
        }
      }
    }
  }
  return map;
}

/**
 * Determine if index lies within an existing wikilink range.
 */
function inExistingLink(index: number, linkRanges: Array<[number, number]>): boolean {
  for (const [s, e] of linkRanges) {
    if (index >= s && index < e) return true;
  }
  return false;
}

/**
 * Recompute wikilink ranges in text.
 */
function computeWikilinkRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\[\[[^\]]+\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * Auto-wikilink entities in the given transcription text.
 */
export async function wikilinkEntities(app: App, currentFile: TFile, content: string): Promise<string> {
  // Build entity map
  const entityMap = buildEntityMap(app, currentFile);
  if (entityMap.size === 0) return content;

  const keys = Array.from(entityMap.keys())
    .filter((k) => k.length > 1) // skip 1-char noise
    .sort((a, b) => b.length - a.length); // longest first

  let text = content;
  let lower = text.toLowerCase();
  const linkedCanonicals = new Set<string>();

  // Pre-capture existing links
  let linkRanges = computeWikilinkRanges(text);

  for (const key of keys) {
    const canonical = entityMap.get(key)!;
    if (linkedCanonicals.has(canonical)) continue;

    let idx = lower.indexOf(key);
    while (idx !== -1) {
      // Boundary checks
      const before = idx === 0 ? "" : lower[idx - 1];
      const after = idx + key.length >= lower.length ? "" : lower[idx + key.length];

      const isWordBefore = /[a-z0-9]/i.test(before);
      const isWordAfter = /[a-z0-9]/i.test(after);

      if (!isWordBefore && !isWordAfter && !inExistingLink(idx, linkRanges)) {
        const original = text.slice(idx, idx + key.length);
        // Prepare replacement
        const replacement =
          original === canonical
            ? `[[${canonical}]]`
            : `[[${canonical}|${original}]]`;

        // Apply replacement
        text = text.slice(0, idx) + replacement + text.slice(idx + key.length);
        // Update lower to maintain alignment for subsequent searches (only needed if continuing)
        lower = text.toLowerCase();
        // Mark canonical as linked
        linkedCanonicals.add(canonical);
        // Recompute link ranges after insertion
        linkRanges = computeWikilinkRanges(text);
        break; // only first occurrence for this entity
      }

      // Find next occurrence if boundary or inside link invalid
      idx = lower.indexOf(key, idx + key.length);
    }
  }

  return text;
}
