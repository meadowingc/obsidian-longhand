import OpenAI from "openai";

export interface LlmInputItem {
  fileName: string;
  alt: string;
  ocrText: string;
  dataUrl?: string; // data URL (e.g., image/jpeg;base64,...) for vision models
}

/**
 * Sends a single request to OpenAI (gpt-4o) with:
 * - A structured text summary of all images and their OCR text
 * - The image contents themselves (for those where dataUrl is available)
 * Returns markdown transcription suitable for inserting into the note.
 */
export async function openAiTranscription(apiKey: string, items: LlmInputItem[]): Promise<string> {
  // Only allow image types commonly supported by OpenAI vision (png, jpeg, webp, gif)
  const usable = items.filter(
    (i) => !!i.dataUrl && /^data:image\/(png|jpe?g|webp|gif);/i.test(i.dataUrl)
  );
  if (usable.length === 0) {
    throw new Error("No images available to send to the model.");
  }

  const descriptor = buildDescriptorMarkdown(items);

  const client = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const userContent: any[] = [
    {
      type: "text",
      text: descriptor,
    },
    // append images after the text content
    ...usable.map((i) => ({
      type: "image_url",
      image_url: { url: i.dataUrl as string },
    })),
  ];

  const systemPrompt = [
    "You are an assistant transcribing handwritten notes from images.",
    "Goals:",
    "- Produce clean, readable markdown.",
    "- Preserve paragraphs, lists, quotes, headings if apparent.",
    "- Use the provided OCR text as primary input; consult images to correct OCR mistakes.",
    "- Keep the author's original wording and style; do not add meta commentary.",
    "- If uncertain about a word, use your best judgment from context.",
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent as any },
    ],
  });

  const text =
    resp.choices?.[0]?.message?.content?.toString?.() ??
    (resp.choices?.[0]?.message?.content as unknown as string) ??
    "";

  return (text ?? "").trim();
}

function buildDescriptorMarkdown(items: LlmInputItem[]): string {
  const lines: string[] = [];
  lines.push("Transcribe the following images. For each image we provide a name, optional alt text, and OCR text.");
  lines.push("");
  items.forEach((i, idx) => {
    lines.push(`Image ${idx + 1}: ${i.fileName}${i.alt ? ` (${i.alt})` : ""}`);
    lines.push("");
    if (i.ocrText && i.ocrText.trim()) {
      lines.push("OCR text:");
      lines.push("```");
      lines.push(i.ocrText.trim());
      lines.push("```");
    } else {
      lines.push("(No OCR text available for this image.)");
    }
    lines.push("");
  });
  lines.push("");
  lines.push("Please output only the transcription in markdown. There's no need to wrap it in triple backticks as this will be added directly to an Obsidian note for display.");
  return lines.join("\n");
}
