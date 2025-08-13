import { App, TFile, normalizePath } from "obsidian";

export interface NoteImageRef {
  file: TFile;
  alt?: string;
}

/**
 * Collect image embeds from a note, preserving order of appearance.
 * Supports wiki-style embeds ![[img.png]] and markdown images ![alt](img.png).
 */
export async function collectImagesFromNote(app: App, file: TFile, limit: number): Promise<NoteImageRef[]> {
  const cache = app.metadataCache.getFileCache(file);
  const embeds = cache?.embeds ?? [];
  const links = cache?.links ?? [];

  const results: NoteImageRef[] = [];
  const seen = new Set<string>();

  for (const e of embeds) {
    const rawLink = (e as any).link as string | undefined;
    if (!rawLink) continue;

    // Ignore external URLs
    if (/^[a-z]+:\/\//i.test(rawLink)) continue;

    // Strip size pipes like "image.png|100x100"
    const linkNoPipe = rawLink.split("|")[0].trim();

    // Only accept likely image extensions
    if (!/\.(png|jpe?g|webp|gif|bmp|tif?f|heic|heif)$/i.test(linkNoPipe)) continue;

    // Resolve to a vault file relative to the note
    const resolved = app.metadataCache.getFirstLinkpathDest(linkNoPipe, file.path);
    if (resolved && resolved instanceof TFile) {
      results.push({
        file: resolved,
        alt: (e as any).displayText || undefined,
      });
      seen.add(resolved.path);
    }

    if (results.length >= limit) break;
  }

  // Also scan markdown links that resolve to images
  for (const l of links) {
    const rawLink = (l as any).link as string | undefined;
    if (!rawLink) continue;

    // Ignore external URLs
    if (/^[a-z]+:\/\//i.test(rawLink)) continue;

    // Strip size pipes like "image.png|100x100"
    const linkNoPipe = rawLink.split("|")[0].trim();

    // Only accept likely image extensions
    if (!/\.(png|jpe?g|webp|gif|bmp|tif?f|heic|heif)$/i.test(linkNoPipe)) continue;

    // Resolve to a vault file relative to the note
    const resolved = app.metadataCache.getFirstLinkpathDest(linkNoPipe, file.path);
    if (resolved && resolved instanceof TFile && !seen.has(resolved.path)) {
      results.push({
        file: resolved,
        alt: (l as any).displayText || undefined,
      });
      seen.add(resolved.path);
    }

    if (results.length >= limit) break;
  }

  return results;
}
