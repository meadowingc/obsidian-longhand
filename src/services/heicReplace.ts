import { App, TFile, normalizePath } from "obsidian";
import { type RetryOptions, withRetry } from "./retry";

export async function convertHeicBytesToJpeg(bytes: ArrayBuffer): Promise<Blob> {
  // Defer the browser-only converter until a HEIC image is actually encountered.
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({
    blob: new Blob([bytes], { type: "image/heic" }),
    toType: "image/jpeg",
    quality: 0.92,
  });
  if (Array.isArray(converted)) {
    throw new Error("HEIC conversion returned multiple images. Export each page as JPEG or PNG.");
  }
  return converted;
}

/**
 * Convert a HEIC/HEIF vault file to a JPEG file in the same folder.
 * - Uses quality 0.92 (same as imagePrep).
 * - Avoids name collisions by appending " (n)".
 * - Returns the created JPEG TFile.
 */
export async function convertHeicVaultFileToJpeg(app: App, heicFile: TFile, retry?: RetryOptions): Promise<TFile> {
  const originalBytes = await withRetry(() => app.vault.readBinary(heicFile), retry);
  const jpegBlob = await convertHeicBytesToJpeg(originalBytes);

  const jpegBytes = await jpegBlob.arrayBuffer();

  const folder = heicFile.parent?.path ?? "";
  const base = heicFile.basename;

  let fileName = `${base}.jpg`;
  let outPath = folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);

  // Avoid collisions
  let counter = 1;
  // adapter.exists returns boolean
  while (await withRetry(() => app.vault.adapter.exists(outPath), retry)) {
    fileName = `${base} (${counter}).jpg`;
    outPath = folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);
    counter++;
  }

  return withRetry(async () => {
    // Keep the same path on retry and recognize a write that succeeded before throwing.
    const existing = app.vault.getAbstractFileByPath(outPath);
    if (existing instanceof TFile) {
      const stored = new Uint8Array(await app.vault.readBinary(existing));
      const expected = new Uint8Array(jpegBytes);
      if (stored.length === expected.length && stored.every((byte, index) => byte === expected[index])) return existing;
      throw new Error(`Cannot save JPEG: ${outPath} already contains different data.`);
    }
    return app.vault.createBinary(outPath, jpegBytes);
  }, retry);
}

/**
 * Rewrite links in a note from old image paths to new image paths.
 * - Supports wiki embeds ![[...]] and markdown images ![alt](...).
 * - Preserves size pipes "|100x100" and other suffix after the link target.
 * - Only replaces the target path portion (not alt text or other syntax).
 *
 * replacements: Map of old absolute vault path -> new absolute vault path
 */
export async function rewriteNoteLinks(app: App, note: TFile, replacements: Map<string, string>, retry?: RetryOptions): Promise<void> {
  if (!replacements.size) return;

  const original = await withRetry(() => app.vault.read(note), retry);
  const cache = app.metadataCache.getFileCache(note);
  if (!cache) return;

  const ops: { start: number; end: number; newText: string }[] = [];

  // Helper to build new linktext relative to the note for a given absolute path
  const toLinkText = (absPath: string): string => {
    const af = app.vault.getAbstractFileByPath(absPath);
    if (af && af instanceof TFile) {
      // fileToLinktext computes a relative path usable both in wiki and markdown targets
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (app.metadataCache as any).fileToLinktext(af, note.path);
    }
    // Fallback to raw path (should not happen as we just created files)
    return absPath;
  };

  // Process wiki-style embeds ![[...]]
  const embeds = cache.embeds ?? [];
  for (const e of embeds as any[]) {
    const rawLink: string | undefined = e?.link;
    const pos = e?.position;
    if (!rawLink || pos?.start?.offset == null || pos?.end?.offset == null) continue;

    // Strip size pipe (e.g., "foo.heic|100x100")
    const linkNoPipe = rawLink.split("|")[0].trim();

    const resolved = app.metadataCache.getFirstLinkpathDest(linkNoPipe, note.path);
    if (!resolved || !(resolved instanceof TFile)) continue;

    const newAbs = replacements.get(resolved.path);
    if (!newAbs) continue;

    const pipeSuffix = rawLink.includes("|") ? rawLink.slice(rawLink.indexOf("|")) : "";
    const newTarget = `${toLinkText(newAbs)}${pipeSuffix}`;

    // For ![[...]] the inner target starts after "![[", ends before "]]"
    const start = pos.start.offset + 3;
    const end = pos.end.offset - 2;
    if (start < end) {
      ops.push({ start, end, newText: newTarget });
    }
  }

  // Process markdown links/images ![alt](...)
  const links = cache.links ?? [];
  for (const l of links as any[]) {
    const rawLink: string | undefined = l?.link;
    const pos = l?.position;
    if (!rawLink || pos?.start?.offset == null || pos?.end?.offset == null) continue;

    const linkNoPipe = rawLink.split("|")[0].trim();
    const resolved = app.metadataCache.getFirstLinkpathDest(linkNoPipe, note.path);
    if (!resolved || !(resolved instanceof TFile)) continue;

    const newAbs = replacements.get(resolved.path);
    if (!newAbs) continue;

    const pipeSuffix = rawLink.includes("|") ? rawLink.slice(rawLink.indexOf("|")) : "";
    const newTarget = `${toLinkText(newAbs)}${pipeSuffix}`;

    const sliceStart = pos.start.offset;
    const sliceEnd = pos.end.offset;
    const slice = original.slice(sliceStart, sliceEnd);

    // Prefer to replace between the last '(' and the matching ')'
    const openIdx = slice.lastIndexOf("(");
    const closeIdx = slice.lastIndexOf(")");
    if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
      const innerStart = sliceStart + openIdx + 1;
      const innerEnd = sliceStart + closeIdx;
      ops.push({ start: innerStart, end: innerEnd, newText: newTarget });
      continue;
    }

    // Fallback: replace the raw link substring if found
    const rawIdx = slice.indexOf(rawLink);
    if (rawIdx !== -1) {
      const innerStart = sliceStart + rawIdx;
      const innerEnd = innerStart + rawLink.length;
      ops.push({ start: innerStart, end: innerEnd, newText: newTarget });
    }
  }

  if (!ops.length) return;

  // Apply edits from right to left to keep offsets valid
  ops.sort((a, b) => b.start - a.start);

  let updated = original;
  for (const op of ops) {
    updated = updated.slice(0, op.start) + op.newText + updated.slice(op.end);
  }

  if (updated !== original) {
    await withRetry(() => app.vault.process(note, (current) => {
      if (current === updated) return current;
      if (current !== original) {
        throw new Error("The note changed while replacing HEIC embeds. Run the command again to preserve your edits.");
      }
      return updated;
    }), retry);
  }
}
