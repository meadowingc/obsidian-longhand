import { App, TFile } from "obsidian";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - runtime-only lib with no types by default
import heic2any from "heic2any";

export interface PreparedImage {
  ocrBytes: ArrayBuffer;
  llmDataUrl?: string; // data URL for model input (optionally downscaled/converted)
}

/**
 * Reads image bytes from the vault, optionally converts HEIC->JPEG, and optionally
 * downsamples ONLY the LLM input while keeping OCR at highest available resolution.
 */
export async function prepareForProcessing(
  app: App,
  file: TFile,
  convertHeicToJpeg: boolean,
  downscaleForLLM: boolean
): Promise<PreparedImage> {
  const originalBytes = await app.vault.readBinary(file);
  const isHeic =
    /\.hei[cf]$/i.test(file.name) || looksHeicByHeader(originalBytes);

  let ocrBlob: Blob | null = null;
  let llmBlob: Blob | null = null;

  // Prefer converting HEIC so Azure OCR and LLM both receive broadly supported JPEG
  if (isHeic && convertHeicToJpeg) {
    try {
      const heicBlob = new Blob([originalBytes]);
      const jpegBlob = (await (heic2any as any)({
        blob: heicBlob,
        toType: "image/jpeg",
        quality: 0.92,
      })) as Blob;

      ocrBlob = jpegBlob;
      llmBlob = jpegBlob;
    } catch (e) {
      console.warn("HEIC conversion failed; falling back to original bytes.", e);
    }
  }

  if (!ocrBlob) {
    ocrBlob = new Blob([originalBytes]);
  }
  if (!llmBlob) {
    // Ensure the LLM blob has a valid image MIME type for data URLs
    const mime = guessImageMime(file.name, originalBytes);
    if (mime) {
      llmBlob = new Blob([originalBytes], { type: mime });
    } else {
      // Fallback: create without explicit type (may still work), later downscale step converts to JPEG
      llmBlob = new Blob([originalBytes]);
    }
  }

  // Downscale only the model input (to reduce cost); OCR remains high-res
  if (downscaleForLLM) {
    try {
      llmBlob = await downscaleBlob(llmBlob, 2048, "image/jpeg", 0.9);
    } catch (e) {
      console.warn("Downscale failed; using original for LLM input.", e);
    }
  }

  let llmDataUrl: string | undefined = undefined;
  try {
    llmDataUrl = await blobToDataUrl(llmBlob);
  } catch (e) {
    console.warn("Failed to build data URL for LLM input.", e);
  }

  const ocrBytes = await ocrBlob.arrayBuffer();

  return { ocrBytes, llmDataUrl };
}

function looksHeicByHeader(bytes: ArrayBuffer): boolean {
  const sigs = ["ftypheic", "ftypheix", "ftyphevc", "ftyphevx", "ftypmif1", "ftypmsf1"];
  const head = new Uint8Array(bytes.slice(0, 64));
  let ascii = "";
  for (let i = 0; i < head.length; i++) ascii += String.fromCharCode(head[i]);
  return sigs.some((s) => ascii.includes(s));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Failed to read blob as data URL"));
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
}

async function downscaleBlob(
  blob: Blob,
  maxEdge: number,
  mime: string,
  quality: number
): Promise<Blob> {
  const img = await loadImageFromBlob(blob);
  const width = (img as any).naturalWidth || img.width;
  const height = (img as any).naturalHeight || img.height;
  const maxDim = Math.max(width, height);

  if (!maxDim || maxDim <= maxEdge) {
    // No need to downscale
    return blob;
  }

  const scale = maxEdge / maxDim;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return blob;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, quality)
  );
  return out ?? blob;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Try to determine a suitable image MIME type from filename or header bytes.
 * Ensures data URLs look like data:image/png;base64,... instead of application/octet-stream.
 */
function guessImageMime(fileName: string, bytes: ArrayBuffer): string | undefined {
  const byExt = guessMimeByExt(fileName);
  if (byExt) return byExt;
  return guessMimeByHeader(bytes);
}

function guessMimeByExt(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function guessMimeByHeader(bytes: ArrayBuffer): string | undefined {
  const u8 = new Uint8Array(bytes);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    u8.length >= 8 &&
    u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
    u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a
  ) return "image/png";

  // JPEG: FF D8 FF
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "image/jpeg";

  // GIF: "GIF87a" or "GIF89a"
  if (u8.length >= 6) {
    const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4], u8[5]);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }

  // WEBP: "RIFF"...."WEBP"
  if (u8.length >= 12) {
    const riff = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    const webp = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }

  // BMP: "BM"
  if (u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) return "image/bmp";

  return undefined;
}
