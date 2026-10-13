import OpenAI, { type APIError } from "openai";
import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LonghandSettings } from "../settings";
import { RetryExhaustedError, type RetryInfo, withRetry } from "./retry";

class IncompleteStreamError extends Error {}

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
  settings: Pick<LonghandSettings, "openaiApiKey" | "openaiBaseUrl" | "openaiModel" | "requestStreaming" | "retryTransientErrors">,
  items: LlmInputItem[],
  personalContext?: string,
  onRetry?: (info: RetryInfo) => void
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
  let streamComplete = false;
  let streamSupported = false;

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
      // requestUrl buffers SSE, but provider-to-proxy bytes still arrive incrementally.
      streamComplete = /(?:^|[\r\n])data:[ \t]*\[DONE\][ \t]*(?:[\r\n]|$)/.test(response.text);
      const result = new Response(response.text, { status: response.status, headers: response.headers });
      streamSupported = /text\/event-stream/i.test(result.headers.get("content-type") ?? "") ||
        /(?:^|[\r\n])data:/.test(response.text);
      return result;
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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  return withRetry(async () => {
    streamComplete = false;
    streamSupported = false;
    if (!settings.requestStreaming) {
      const resp = await client.chat.completions.create({ model, messages });
      const choice = resp.choices?.[0];
      return validateTranscription(choice?.message?.content, choice?.finish_reason, choice?.message?.refusal);
    }

    const stream = await client.chat.completions.create({ model, messages, stream: true });
    if (!streamSupported) {
      throw new Error("The provider did not return a streaming response. For JSON-only endpoints, disable Request streaming responses.");
    }
    let content = "";
    let refusal = "";
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      if ("stream_error" in chunk) {
        const failure = chunk.stream_error;
        const details: { message: string; code?: string } = { message: "The provider reported a failed response stream." };
        if (typeof failure === "object" && failure !== null) {
          if ("message" in failure && typeof failure.message === "string") details.message = failure.message;
          if ("code" in failure && typeof failure.code === "string") details.code = failure.code;
        }
        throw new OpenAI.APIError(undefined, details, undefined, undefined);
      }
      const choice = chunk.choices?.find((entry) => entry.index === 0);
      if (!choice) continue;
      content += choice.delta?.content ?? "";
      refusal += choice.delta?.refusal ?? "";
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (finishReason === "length" || finishReason === "content_filter" || refusal) {
      validateTranscription(content, finishReason, refusal);
    }
    if (!streamComplete || !finishReason) {
      throw new IncompleteStreamError("The provider's response stream ended before completion. No transcription was inserted. Check provider usage before retrying. If your endpoint only supports JSON responses, disable Request streaming responses.");
    }
    return validateTranscription(content, finishReason, refusal);
  }, {
    maxRetries: settings.retryTransientErrors ? 2 : 0,
    shouldRetry: isTransientModelError,
    retryAfterMs: modelRetryAfterMs,
    onRetry,
  });
}

function hasCreditError(error: APIError): boolean {
  const code = `${error.code ?? ""} ${error.type ?? ""}`;
  return error.status === 402 ||
    /insufficient_quota|insufficient_credits|billing_hard_limit_reached/.test(code) ||
    /insufficient.*(credit|balance|quota)|exceeded.*quota/i.test(error.message);
}

function hasPermanentProviderError(error: APIError): boolean {
  const code = `${error.code ?? ""} ${error.type ?? ""}`;
  return hasCreditError(error) ||
    /invalid_api_key|authentication_error|permission_denied|invalid_request_error|model_not_found|content_filter/.test(code) ||
    /failed authentication|invalid api key/i.test(error.message);
}

function isTransientModelError(error: unknown): boolean {
  // requestUrl cannot cancel the underlying native request after an SDK timeout.
  if (error instanceof OpenAI.APIConnectionTimeoutError) return false;
  if (error instanceof OpenAI.APIConnectionError || error instanceof IncompleteStreamError) return true;
  if (!(error instanceof OpenAI.APIError) || hasPermanentProviderError(error)) return false;
  return [408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(error.status ?? 0) ||
    (error.status === undefined && /^(generation_failed|upstream_error|upstream_timeout|overloaded|rate_limit_exceeded)$/.test(error.code ?? ""));
}

function modelRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const header = (name: string): string | undefined => {
    const value = Object.entries(error.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
    return typeof value === "string" ? value : undefined;
  };
  const milliseconds = header("retry-after-ms");
  if (milliseconds?.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) return Number(milliseconds);
  const value = header("retry-after");
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function validateTranscription(content: string | null | undefined, finishReason: string | null | undefined, refusal?: string | null): string {
  if (finishReason === "length") {
    throw new Error("The model's output limit was reached. Try fewer images or a model with a larger output limit.");
  }
  if (finishReason === "content_filter" || refusal) {
    throw new Error("The model declined to transcribe these images. Check your provider's content policy.");
  }
  const text = content?.trim();
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
  if (error instanceof RetryExhaustedError) {
    return `Failed after ${error.attempts} attempts. ${formatModelError(error.cause)}`;
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return "The plugin timed out waiting for the model provider. The native request may still be running, so it was not automatically retried. Check provider usage before trying again. Try fewer images or a faster vision model.";
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return "Could not connect to the model provider. Check the API base URL and your network connection.";
  }
  if (error instanceof OpenAI.APIError) {
    if (hasCreditError(error)) {
      return "Not enough API credits or quota. Check billing and usage limits for your configured provider. A ChatGPT subscription does not include OpenAI API credits.";
    }
    if (error.status === 524 || error.status === 504) {
      return `The provider's gateway timed out (HTTP ${error.status}). Try again later, use a faster vision model, or send fewer images with Downscale images for LLM enabled. Increasing the plugin timeout will not fix a provider-side timeout. Timed-out requests may still be billed; check provider usage before trying again.`;
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
