import { App, TFile } from "obsidian";
import { convertHeicBytesToJpeg } from "./heicReplace";
import { type RetryOptions, withRetry } from "./retry";

export interface PreparedImage {
  llmDataUrl: string;
}

/**
 * Reads image bytes, converts unsupported formats, and optionally downsamples.
 */
export async function prepareForProcessing(
  app: App,
  file: TFile,
  convertHeicToJpeg: boolean,
  downscaleForLLM: boolean,
  retry?: RetryOptions
): Promise<PreparedImage> {
  const originalBytes = await withRetry(() => app.vault.readBinary(file), retry);
  const isHeic =
    /\.hei[cf]$/i.test(file.name) || looksHeicByHeader(originalBytes);

  let llmBlob: Blob;
  if (isHeic) {
    if (!convertHeicToJpeg) {
      throw new Error("HEIC images require conversion. Enable Convert HEIC to JPEG or export the image as JPEG/PNG.");
    }
    llmBlob = await convertHeicBytesToJpeg(originalBytes);
  } else {
    const mime = guessImageMime(file.name, originalBytes);
    if (!mime) throw new Error("Unsupported image format. Export the image as JPEG or PNG.");
    llmBlob = new Blob([originalBytes], { type: mime });
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
      llmBlob = await downscaleBlob(llmBlob, Infinity, "image/jpeg", 0.92, true);
    }
  }

  if (downscaleForLLM) {
    llmBlob = await downscaleBlob(llmBlob, 2048, "image/jpeg", 0.9);
  }

  return { llmDataUrl: await blobToDataUrl(llmBlob) };
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
    fr.onload = () => {
      if (typeof fr.result !== "string") {
        reject(new Error("Failed to read image as a data URL."));
        return;
      }
      resolve(fr.result);
    };
    fr.readAsDataURL(blob);
  });
}

async function downscaleBlob(
  blob: Blob,
  maxEdge: number,
  mime: string,
  quality: number,
  forceConversion = false
): Promise<Blob> {
  const img = await loadImageFromBlob(blob);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const maxDim = Math.max(width, height);

  if (!maxDim) throw new Error("Image has no readable dimensions. Export it as JPEG or PNG.");
  if (maxDim <= maxEdge && !forceConversion) return blob;

  const scale = Math.min(1, maxEdge / maxDim);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create a canvas to prepare the image.");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, quality)
  );
  if (!out) throw new Error("Could not convert the image to JPEG.");
  return out;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the image on this device. Export it as JPEG or PNG."));
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
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
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
