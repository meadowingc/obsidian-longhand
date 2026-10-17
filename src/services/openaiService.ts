import OpenAI, { type APIError } from "openai";
import { Platform, requestUrl, type RequestUrlResponse } from "obsidian";
import type { LonghandSettings } from "../settings";
import { RetryExhaustedError, type RetryInfo, withRetry } from "./retry";

class IncompleteStreamError extends Error {}

class AndroidHostnameFallbackError extends Error {
  constructor(readonly cause: unknown) {
    super("Android rejected the provider hostname and its browser-network fallback failed.");
  }
}

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
      const response = await new Promise<Pick<RequestUrlResponse, "status" | "headers" | "text">>((resolve, reject) => {
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
        }).catch(async (error: unknown) => {
          if (!Platform?.isAndroidApp || connectionFailure(error) !== "hostname") throw error;
          // Android's native hostname parser rejects underscores before sending.
          // WebView networking accepts them, but still enforces CORS and TLS.
          try {
            // SDK telemetry can exceed a compatible gateway's CORS allowlist.
            const browserHeaders = Object.fromEntries(Object.entries(headers).filter(
              ([name]) => !/^(?:x-stainless-|content-length$|user-agent$)/i.test(name)
            ));
            const result = await fetch(request.url, {
              method: request.method,
              headers: browserHeaders,
              body,
              signal: request.signal,
              credentials: "omit",
              redirect: "error",
            });
            const responseHeaders: Record<string, string> = {};
            result.headers.forEach((value, key) => { responseHeaders[key] = value; });
            return { status: result.status, headers: responseHeaders, text: await result.text() };
          } catch (cause) {
            if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
            throw new AndroidHostnameFallbackError(cause);
          }
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

type ConnectionFailure = "certificate" | "cleartext" | "dns" | "refused" | "timeout" | "runtime" | "hostname";

function connectionFailure(error: unknown): ConnectionFailure | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error !== undefined && !seen.has(error); depth++) {
    seen.add(error);
    const current = error;
    if (current instanceof AndroidHostnameFallbackError) return "hostname";
    const details = typeof current === "string" ? current :
      typeof current === "object" && current !== null
        ? ["name", "code", "message"].map((key) => {
          const value = Reflect.get(current, key);
          return typeof value === "string" ? value : "";
        }).join(" ")
        : "";
    if (/IllegalArgumentException:?\s+Invalid input to toASCII/i.test(details)) return "hostname";
    if (/certificate|cert_authority_invalid|cert_date_invalid|cert_common_name_invalid|cert_invalid|cert_has_expired|unable_to_verify_leaf_signature|self_signed_cert|sslhandshake|sslpeerunverified|trust anchor|certpathvalidator/i.test(details)) return "certificate";
    if (/cleartext|err_cleartext_not_permitted|insecure requests? (?:is|are) not allowed/i.test(details)) return "cleartext";
    if (/unknownhost|enotfound|eai_again|err_name_not_resolved|unable to resolve host|no address associated with hostname/i.test(details)) return "dns";
    if (/econnrefused|enetunreach|ehostunreach|err_connection_refused|err_address_unreachable|failed to connect to/i.test(details)) return "refused";
    if (/sockettimeoutexception|etimedout|err_connection_timed_out|err_timed_out|timed out|timeout/i.test(details)) return "timeout";
    if (/\b(?:Request|Response|Headers|ReadableStream|TextEncoder|AbortController|fetch)\b.*(?:not defined|not a constructor|not supported|undefined)/i.test(details)) return "runtime";
    error = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

function isTransientModelError(error: unknown): boolean {
  // requestUrl cannot cancel the underlying native request after an SDK timeout.
  if (error instanceof OpenAI.APIConnectionTimeoutError) return false;
  if (error instanceof OpenAI.APIConnectionError) {
    const failure = connectionFailure(error);
    return failure !== "certificate" && failure !== "cleartext" && failure !== "runtime" && failure !== "timeout" && failure !== "hostname";
  }
  if (error instanceof IncompleteStreamError) return true;
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
    switch (connectionFailure(error)) {
      case "certificate":
        return "The device rejected the provider's HTTPS certificate. Android can trust a different set of certificates than your PC. Check the server's certificate chain, expiry, and the phone's date/time; use a publicly trusted certificate rather than disabling TLS verification. No model HTTP response was received.";
      case "cleartext":
        return "The device blocked an unencrypted HTTP connection. Use an HTTPS API base URL with a valid certificate. No model HTTP response was received.";
      case "dns":
        return "The device could not resolve the provider's hostname. Check the phone's DNS, VPN, and Wi-Fi/mobile-data access. A hostname that resolves on your PC may not resolve on Android. No model HTTP response was received.";
      case "refused":
        return "The device could not reach the provider's server. Check its port, firewall, VPN, and whether the phone can access the same network as your PC. localhost refers to the phone itself, not your PC. No model HTTP response was received.";
      case "timeout":
        return "The device's native network request timed out before an HTTP response was returned. Keep Obsidian in the foreground, try Downscale images for LLM or fewer images, and check the phone's connection. The provider may still be processing the request, so it was not automatically retried; check provider usage before trying again.";
      case "runtime":
        return "The device's web runtime does not support a networking API required by the plugin. Update Obsidian and Android System WebView/Chrome, then restart Obsidian. No model HTTP response could be read; check provider usage before trying again.";
      case "hostname":
        return "Android's native network layer rejected the provider hostname. Use a hostname without underscores, or allow Obsidian's origin through the provider's CORS configuration so the browser-network fallback can work. HTTPS certificate validation is still required. The request was not automatically retried; the browser attempt may have reached the provider, so check usage before trying again.";
      default:
        return "Could not connect to the model provider through Obsidian's native network connection. No model HTTP response could be read. Check the API base URL, the phone's VPN/DNS and HTTPS certificate trust, and keep Obsidian in the foreground. Matching API keys do not guarantee the same network access on desktop and Android.";
    }
  }
  if (error instanceof OpenAI.APIError) {
    if (hasCreditError(error)) {
      return "Not enough API credits or quota. Check billing and usage limits for your configured provider. A ChatGPT subscription does not include OpenAI API credits.";
    }
    if (error.status === 524 || error.status === 504) {
      return `The provider's gateway timed out (HTTP ${error.status}). Try again later, use a faster vision model, or send fewer images with Downscale images for LLM enabled. Increasing the plugin timeout will not fix a provider-side timeout. Timed-out requests may still be billed; check provider usage before trying again.`;
    }
    if (error.status === 401) return "API authentication failed. Check that your API key belongs to the provider at the configured base URL.";
    if (error.status === 403) return "The provider or its gateway denied this request (HTTP 403). Check API-key permissions and any IP, VPN, geographic, or browser-challenge restrictions; your phone may reach the endpoint from a different network than your PC.";
    if (error.status === 408) return "The provider timed out while receiving the request (HTTP 408). Enable Downscale images for LLM, try fewer images, and check the phone's upload connection.";
    if (error.status === 413) return "The provider rejected the request because it is too large (HTTP 413). Enable Downscale images for LLM or send fewer images. The unchanged payload was not automatically retried.";
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
