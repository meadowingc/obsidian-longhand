export async function azureOcr(
  imageBytes: ArrayBuffer,
  endpoint: string,
  apiKey: string
): Promise<string> {
  if (!endpoint || !apiKey) {
    throw new Error("Azure OCR endpoint or key not set.");
  }

  const url =
    endpoint.replace(/\/+$/, "") +
    "/computervision/imageanalysis:analyze?features=read&model-version=latest&language=en&gender-neutral-caption=false&api-version=2023-10-01";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: imageBytes,
  });

  if (!res.ok) {
    const msg = `Azure OCR failed: ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  const data = await res.json();

  // Defensive parsing: prefer readResult.blocks -> lines -> words
  try {
    if (data?.readResult?.blocks) {
      const text = data.readResult.blocks
        .flatMap((b: any) =>
          (b.lines ?? []).flatMap((l: any) =>
            (l.words ?? []).map((w: any) => w.text)
          )
        )
        .join(" ")
        .trim();
      if (text) return text;
    }

    // Fallbacks sometimes seen in other API shapes
    if (data?.readResult?.content) {
      return String(data.readResult.content).trim();
    }
    if (Array.isArray(data?.readResult?.lines)) {
      const text = data.readResult.lines
        .map((l: any) => l.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
  } catch {
    // ignore and fall through
  }

  // Last resort: stringify minimal info
  return "";
}
