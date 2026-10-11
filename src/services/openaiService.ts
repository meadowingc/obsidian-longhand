import OpenAI from "openai";
import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LonghandSettings } from "../settings";

export interface LlmInputItem {
  fileName: string;
  alt: string;
  dataUrl: string;
}

/**
 * Sends images to an OpenAI-compatible vision model.
 * Returns markdown transcription suitable for inserting into the note.
 */
export async function openAiTranscription(
  settings: Pick<LonghandSettings, "openaiApiKey" | "openaiBaseUrl" | "openaiModel">,
  items: LlmInputItem[],
  personalContext?: string
): Promise<string> {
  if (items.length === 0) {
    throw new Error("No images available to send to the model.");
  }
  for (const item of items) {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(item.dataUrl)) {
      throw new Error(`Unsupported model image format for ${item.fileName}. Use PNG, JPEG, WEBP, or GIF.`);
    }
  }
  const baseURL = validateBaseUrl(settings.openaiBaseUrl);
  const apiKey = settings.openaiApiKey.trim();
  const model = settings.openaiModel.trim();
  if (!apiKey) throw new Error("Set your provider's API key in Longhand settings.");
  if (!model) throw new Error("Set a vision-capable model ID in Longhand settings.");

  const descriptor = buildDescriptorMarkdown(items);

  const client = new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    // Obsidian's native transport avoids browser CORS restrictions on desktop and mobile.
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      const body = await request.text();
      const response = await new Promise<RequestUrlResponse>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          request.signal.removeEventListener("abort", onAbort);
          onAbort();
          return;
        }
        requestUrl({
          url: request.url,
          method: request.method,
          headers,
          body,
          throw: false,
        }).then(resolve, reject).then(() => {
          request.signal.removeEventListener("abort", onAbort);
        });
      });
      return new Response(response.text, { status: response.status, headers: response.headers });
    },
  });

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: descriptor,
    },
    ...items.map((i): OpenAI.Chat.Completions.ChatCompletionContentPartImage => ({
      type: "image_url",
      image_url: { url: i.dataUrl },
    })),
  ];

  const systemParts = [
    "You are an assistant transcribing handwritten notes from images.",
    "Goals:",
    "- Produce clean, readable markdown.",
    "- Preserve paragraphs, lists, quotes, headings if apparent.",
    "- Read the handwriting directly from the images.",
    "- Keep the author's original wording and style; do not add meta commentary.",
    "- If uncertain about a word, use your best judgment from context.",
  ];
  if (personalContext && personalContext.trim()) {
    systemParts.push(
      "",
      "User-provided context (use only if relevant; prefer image evidence):",
      personalContext.trim()
    );
  }
  const systemPrompt = systemParts.join("\n");

  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const choice = resp.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("The model's output limit was reached. Try fewer images or a model with a larger output limit.");
  }
  if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) {
    throw new Error("The model declined to transcribe these images. Check your provider's content policy.");
  }
  const text = choice?.message?.content?.trim();
  if (!text) throw new Error("The model returned no transcription. Check that your selected model supports image input.");
  return text;
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Set a valid API base URL in Longhand settings, for example https://api.openai.com/v1.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("API base URL must use HTTP or HTTPS without credentials, query parameters, or fragments.");
  }
  if (/\/chat\/completions\/?$/.test(url.pathname)) {
    throw new Error("Use the API base URL, not the full /chat/completions URL.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function formatModelError(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return "The model provider timed out. Try fewer images or a faster vision model.";
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return "Could not connect to the model provider. Check the API base URL and your network connection.";
  }
  if (error instanceof OpenAI.APIError) {
    const code = `${error.code ?? ""} ${error.type ?? ""}`;
    if (
      error.status === 402 ||
      /insufficient_quota|insufficient_credits|billing_hard_limit_reached/.test(code) ||
      /insufficient.*(credit|balance|quota)|exceeded.*quota/i.test(error.message)
    ) {
      return "Not enough API credits or quota. Check billing and usage limits for your configured provider. A ChatGPT subscription does not include OpenAI API credits.";
    }
    if (error.status === 401) return "API authentication failed. Check that your API key belongs to the provider at the configured base URL.";
    if (error.status === 429) return "The provider's rate limit was reached. Wait a moment and try again, or reduce the image limit.";
    if (error.status === 404) return "API endpoint or model not found. Check the API base URL and the provider's exact vision-model ID.";
    return `Model request failed${error.status ? ` (HTTP ${error.status})` : ""}: ${error.message.slice(0, 300)}`;
  }
  return error instanceof Error ? error.message : "Model request failed. See the developer console for details.";
}

function buildDescriptorMarkdown(items: LlmInputItem[]): string {
  const lines: string[] = [];
  lines.push("Transcribe the following images in order. For each image we provide a name and optional alt text.");
  lines.push("");
  items.forEach((i, idx) => {
    lines.push(`Image ${idx + 1}: ${i.fileName}${i.alt ? ` (${i.alt})` : ""}`);
    lines.push("");
  });
  lines.push("");
  lines.push("Please output only the transcription in markdown. There's no need to wrap it in triple backticks as this will be added directly to an Obsidian note for display.");
  return lines.join("\n");
}
