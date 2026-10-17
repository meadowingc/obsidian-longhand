const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const { runInNewContext } = require("node:vm");
const { createServer } = require("node:http");
const OpenAI = require("openai");

function loadSource(file, obsidian = {}, globals = {}, dependencies = {}) {
  const { outputFiles } = buildSync({
    entryPoints: [file], bundle: true, write: false, platform: "node", format: "cjs",
    supported: { "dynamic-import": false },
    external: [...new Set(["obsidian", "openai", "heic2any", "./services/progress", ...Object.keys(dependencies)])],
  });
  const result = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module: result, exports: result.exports,
    require: (id) => id === "obsidian" ? obsidian : dependencies[id] ?? require(id),
    Request, Response, URL, Blob, Error, DOMException, console, setTimeout,
    ...globals,
  });
  return result.exports;
}

const settings = {
  openaiApiKey: "test-key",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o",
  requestStreaming: true,
  retryTransientErrors: false,
};
const image = { fileName: "page.jpg", alt: "handwriting", dataUrl: "data:image/jpeg;base64,/9j/" };
const response = (status, body) => ({
  status, headers: { "content-type": "application/json" }, text: JSON.stringify(body),
});
const jsonCompletion = (content = "Transcription", reason = "stop") =>
  response(200, { choices: [{ finish_reason: reason, message: { role: "assistant", content } }] });
const streamResponse = (chunks, done = true) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  text: ": keepalive\r\n\r\n" + chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : ""),
});
const completion = (content = "Transcription", reason = "stop") => streamResponse([
  { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
  { choices: [], usage: { total_tokens: 10 } },
]);

test("OpenAI-compatible endpoints use the chosen key, model, and ordered vision-only payload", async () => {
  for (const [baseUrl, model] of [
    ["https://api.openai.com/v1", "gpt-4o"],
    ["https://openrouter.ai/api/v1/", "openai/gpt-4o"],
    ["http://localhost:1234/v1", "local-vision-model"],
  ]) {
    const requests = [];
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async (request) => { requests.push(request); return completion("  Transcription  "); },
    });
    const result = await openAiTranscription(
      { ...settings, openaiBaseUrl: baseUrl, openaiModel: model },
      [image, { ...image, fileName: "second.jpg", dataUrl: "data:image/jpeg;base64,AQID" }],
      "My son's name is Roa."
    );
    assert.equal(result, "Transcription");
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, `${baseUrl.replace(/\/$/, "")}/chat/completions`);
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.equal(request.throw, false);
    const body = JSON.parse(request.body);
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(body.messages[1].content[1].image_url.url, image.dataUrl);
    assert.equal(body.messages[1].content[2].image_url.url, "data:image/jpeg;base64,AQID");
    assert.match(body.messages[0].content, /My son's name is Roa/);
    assert.doesNotMatch(JSON.stringify(body), /OCR/);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, undefined);
  }
});

test("streaming accumulates only the first choice and ignores reasoning and usage chunks", async () => {
  const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
    requestUrl: async () => streamResponse([
      { choices: [{ index: 0, delta: { reasoning: "private reasoning" }, finish_reason: null }] },
      { choices: [{ index: 1, delta: { content: "Unwanted choice" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "First " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "second." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { total_tokens: 20 } },
    ]),
  });
  assert.equal(await openAiTranscription(settings, [image]), "First second.");
});

test("provider keepalives prevent a gateway idle timeout even when the client buffers SSE", async (t) => {
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const upstream = createServer(async (request, reply) => {
    let body = "";
    for await (const bytes of request) body += bytes;
    const streaming = JSON.parse(body).stream === true;
    let heartbeat;
    if (streaming) {
      reply.setHeader("Content-Type", "text/event-stream");
      reply.write(": keepalive\n\n");
      heartbeat = setInterval(() => reply.write(": keepalive\n\n"), 100);
    }
    const finish = setTimeout(() => {
      if (streaming) reply.end(completion("Slow transcription").text);
      else {
        reply.setHeader("Content-Type", "application/json");
        reply.end(jsonCompletion("Slow transcription").text);
      }
    }, 1000);
    reply.on("close", () => { clearTimeout(finish); clearInterval(heartbeat); });
  });
  await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = createServer(async (request, reply) => {
    const controller = new AbortController();
    const expire = () => {
      if (reply.headersSent) reply.destroy();
      else { reply.writeHead(524); reply.end(); }
      controller.abort();
    };
    let deadline = setTimeout(expire, 500);
    const resetDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(expire, 500);
    };
    try {
      let body = "";
      for await (const bytes of request) body += bytes;
      const result = await fetch(`${upstreamUrl}${request.url}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal,
      });
      resetDeadline();
      reply.setHeader("Content-Type", result.headers.get("Content-Type"));
      for await (const bytes of result.body) {
        resetDeadline();
        reply.write(bytes);
      }
      reply.end();
    } catch (error) {
      if (!controller.signal.aborted) reply.destroy(error);
    } finally {
      clearTimeout(deadline);
    }
  });
  await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  let requests = 0;
  let buffered;
  const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
    requestUrl: async (request) => {
      requests++;
      const result = await fetch(request.url, {
        method: request.method, headers: request.headers, body: request.body,
      });
      buffered = await result.text();
      return { status: result.status, headers: Object.fromEntries(result.headers), text: buffered };
    },
  });
  const config = { ...settings, openaiBaseUrl: `http://127.0.0.1:${gateway.address().port}/v1` };
  await assert.rejects(openAiTranscription({ ...config, requestStreaming: false }, [image]), (error) => {
    assert.match(formatModelError(error), /HTTP 524/);
    return true;
  });
  assert.equal(await openAiTranscription(config, [image]), "Slow transcription");
  assert.match(buffered, /keepalive/);
  assert.equal(requests, 2);
});

test("JSON-only mode remains available without automatically retrying a streaming request", async () => {
  const requests = [];
  const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
    requestUrl: async (request) => {
      requests.push(JSON.parse(request.body));
      return jsonCompletion("JSON transcription");
    },
  });
  await assert.rejects(openAiTranscription(settings, [image]), /disable Request streaming responses/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.equal(await openAiTranscription({ ...settings, requestStreaming: false }, [image]), "JSON transcription");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].stream, undefined);
});

test("incomplete, empty, refused, and limited streams do not modify the note", async () => {
  const finish = (reason, delta = {}) => ({ choices: [{ index: 0, delta, finish_reason: reason }] });
  const partial = finish(null, { content: "Partial transcription" });
  for (const [result, expected] of [
    [streamResponse([partial], false), /stream ended before completion/],
    [streamResponse([partial]), /stream ended before completion/],
    [streamResponse([partial, finish("stop")], false), /stream ended before completion/],
    [completion("", "stop"), /no transcription/],
    [completion("Partial", "length"), /output limit/],
    [completion(null, "content_filter"), /declined/],
    [streamResponse([finish("stop", { refusal: "Cannot transcribe" })]), /declined/],
    [streamResponse([partial, { stream_error: { message: "Backend failed", code: "generation_failed" } }]), /Backend failed/],
    [streamResponse([partial, { error: { message: "Insufficient credits", code: "insufficient_quota" } }]), /Not enough API credits/],
  ]) {
    let requests = 0;
    const fixture = pluginFixture(async () => { requests++; return result; });
    const original = fixture.getNote();
    await fixture.plugin.processImagesInCurrentNote();
    assert.equal(requests, 1);
    assert.equal(fixture.getNote(), original);
    assert.match(fixture.notices.at(-1), expected);
  }
});

for (const [status, code, message, expected] of [
  [429, "insufficient_quota", "Quota exceeded", /Not enough API credits/],
  [402, null, "Insufficient credits", /Not enough API credits/],
  [403, "insufficient_credits", "Balance too low", /Not enough API credits/],
  [429, null, "Insufficient balance", /Not enough API credits/],
  [429, "rate_limit_exceeded", "Too many requests", /rate limit/],
  [401, "invalid_api_key", "Invalid key", /authentication failed/],
  [404, "model_not_found", "Unknown model", /endpoint or model not found/],
  [400, "invalid_image", "Image input is not supported", /HTTP 400.*Image input is not supported/],
  [500, null, "Provider unavailable", /HTTP 500.*Provider unavailable/],
]) {
  test(`HTTP ${status} (${code ?? message}) is actionable and is not retried`, async () => {
    let requests = 0;
    const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => {
        requests++;
        return response(status, { error: { code, message } });
      },
    });
    await assert.rejects(openAiTranscription(settings, [image]), (error) => {
      assert.match(formatModelError(error), expected);
      return true;
    });
    assert.equal(requests, 1);
  });
}

test("connection errors have network guidance and stalled requests honor SDK timeouts", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 600000 ? 1 : delay, ...args)
  );
  const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
    requestUrl: () => { requests++; return new Promise(() => {}); },
  });
  let requests = 0;
  await assert.rejects(openAiTranscription({ ...settings, retryTransientErrors: true }, [image]), (error) => {
    assert.match(formatModelError(error), /timed out/);
    return true;
  });
  assert.equal(requests, 1);
  assert.match(formatModelError(new OpenAI.APIConnectionError({})), /network connection/);
});

test("native Android failures retain actionable categories without exposing raw exception details", async () => {
  const privateDetails = "https://private.example/v1?token=secret-key Private note text";
  for (const [nativeError, expected] of [
    [new Error(`javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found ${privateDetails}`), /HTTPS certificate.*Android/],
    [Object.assign(new Error(privateDetails), { code: "ERR_CERT_COMMON_NAME_INVALID" }), /HTTPS certificate/],
    [new Error(`Cleartext HTTP traffic not permitted ${privateDetails}`), /blocked an unencrypted HTTP connection/],
    [new Error(`java.net.UnknownHostException: Unable to resolve host ${privateDetails}`), /could not resolve.*DNS/],
    [Object.assign(new Error(privateDetails), { code: "ECONNREFUSED" }), /could not reach.*localhost/],
    [new Error(`java.net.SocketTimeoutException ${privateDetails}`), /native network request timed out.*not automatically retried/],
    [new ReferenceError(`Request is not defined ${privateDetails}`), /web runtime.*Android System WebView/],
    [`ERR_CLEARTEXT_NOT_PERMITTED ${privateDetails}`, /blocked an unencrypted HTTP connection/],
    [new Error(privateDetails), /native network connection.*No model HTTP response could be read/],
  ]) {
    let requests = 0;
    const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => { requests++; throw nativeError; },
    });
    await assert.rejects(openAiTranscription({ ...settings, requestStreaming: false }, [image]), (error) => {
      const message = formatModelError(error);
      assert.match(message, expected);
      assert.doesNotMatch(message, /private\.example|secret-key|Private note text/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("deterministic native failures and ambiguous device timeouts never trigger extra model requests", async () => {
  for (const message of [
    "javax.net.ssl.SSLHandshakeException",
    "ERR_CLEARTEXT_NOT_PERMITTED",
    "Response is not a constructor",
    "java.net.SocketTimeoutException",
  ]) {
    let requests = 0;
    const delays = [];
    const fixture = pluginFixture(async () => {
      requests++;
      throw new Error(message);
    }, undefined, retryTimers(delays));
    fixture.plugin.settings.retryTransientErrors = true;
    const before = fixture.getNote();
    await fixture.plugin.processImagesInCurrentNote();
    assert.equal(requests, 1);
    assert.deepEqual(delays, []);
    assert.equal(fixture.getNote(), before);
    assert.match(fixture.notices.at(-1), /certificate|unencrypted|web runtime|native network request timed out/);
  }
});

test("native DNS failures remain retryable and nested causes are bounded", async () => {
  let requests = 0;
  const delays = [];
  const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
    requestUrl: async () => {
      requests++;
      if (requests === 1) throw Object.assign(new Error("Native request failed"), {
        cause: Object.assign(new Error("DNS lookup failed"), { code: "EAI_AGAIN" }),
      });
      return jsonCompletion("Recovered DNS");
    },
  }, retryTimers(delays));
  assert.equal(await openAiTranscription(
    { ...settings, requestStreaming: false, retryTransientErrors: true }, [image]
  ), "Recovered DNS");
  assert.equal(requests, 2);
  assert.deepEqual(delays, [2000]);
  const cyclic = new Error("Unknown native failure");
  cyclic.cause = cyclic;
  assert.match(formatModelError(new OpenAI.APIConnectionError({ cause: cyclic })), /native network connection/);
  const nested = new OpenAI.APIConnectionError({
    cause: Object.assign(new Error("Bridge failed"), {
      cause: new Error("javax.net.ssl.SSLPeerUnverifiedException"),
    }),
  });
  assert.match(formatModelError(nested), /HTTPS certificate/);
});

test("Android falls back to WebView networking only for the native pre-send hostname rejection", async () => {
  for (const streaming of [false, true]) {
    const nativeRequests = [];
    const browserRequests = [];
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      Platform: { isAndroidApp: true },
      requestUrl: async (request) => {
        nativeRequests.push(request);
        throw new Error("Request Failed. IllegalArgumentException Invalid input to toASCII: synthetic_host.example");
      },
    }, {
      fetch: async (url, options) => {
        assert.equal(Object.keys(options.headers).some((name) => /^x-stainless-|^content-length$|^user-agent$/i.test(name)), false);
        browserRequests.push({ url, ...options });
        const result = streaming ? completion("TEST 123") : jsonCompletion("TEST 123");
        return new Response(result.text, { status: result.status, headers: result.headers });
      },
    });
    assert.equal(await openAiTranscription(
      { ...settings, openaiBaseUrl: "https://synthetic_host.example/v1", requestStreaming: streaming },
      [image]
    ), "TEST 123");
    assert.equal(nativeRequests.length, 1);
    assert.equal(browserRequests.length, 1);
    const browser = browserRequests[0];
    assert.equal(browser.url, nativeRequests[0].url);
    assert.equal(browser.method, "POST");
    assert.equal(browser.body, nativeRequests[0].body);
    assert.equal(browser.headers.authorization, nativeRequests[0].headers.authorization);
    assert.equal(browser.headers["content-type"], nativeRequests[0].headers["content-type"]);
    assert.equal(browser.headers.accept, nativeRequests[0].headers.accept);
    assert.equal(Object.keys(nativeRequests[0].headers).some((name) => /^x-stainless-/i.test(name)), true);
    assert.equal(browser.credentials, "omit");
    assert.equal(browser.redirect, "error");
    assert.equal(browser.signal.aborted, false);
  }
});

test("native certificate, timeout and ordinary connection errors never trigger browser fallback", async () => {
  for (const message of [
    "javax.net.ssl.SSLHandshakeException",
    "java.net.SocketTimeoutException",
    "java.net.UnknownHostException",
    "Connection reset by peer",
  ]) {
    let nativeRequests = 0;
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      Platform: { isAndroidApp: true },
      requestUrl: async () => { nativeRequests++; throw new Error(message); },
    }, { fetch: async () => assert.fail("Must not fall back for ambiguous failures or bypass native TLS errors") });
    await assert.rejects(openAiTranscription({ ...settings, requestStreaming: false }, [image]));
    assert.equal(nativeRequests, 1);
  }
  for (const platform of [{ isAndroidApp: false }, undefined]) {
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      Platform: platform,
      requestUrl: async () => { throw new Error("IllegalArgumentException Invalid input to toASCII"); },
    }, { fetch: async () => assert.fail("Fallback is Android-only") });
    await assert.rejects(openAiTranscription(settings, [image]));
  }
});

test("a failed Android browser fallback surfaces safe CORS guidance without repeating possible model work", async () => {
  let nativeRequests = 0;
  let browserRequests = 0;
  const delays = [];
  const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
    Platform: { isAndroidApp: true },
    requestUrl: async () => {
      nativeRequests++;
      throw new Error("IllegalArgumentException Invalid input to toASCII: private_host.example");
    },
  }, {
    ...retryTimers(delays),
    fetch: async () => { browserRequests++; throw new TypeError("Failed to fetch private_host.example secret-key"); },
  });
  await assert.rejects(openAiTranscription({ ...settings, retryTransientErrors: true }, [image]), (error) => {
    const message = formatModelError(error);
    assert.match(message, /hostname.*CORS.*HTTPS certificate validation.*not automatically retried.*may have reached/);
    assert.doesNotMatch(message, /private_host|secret-key/);
    return true;
  });
  assert.equal(nativeRequests, 1);
  assert.equal(browserRequests, 1);
  assert.deepEqual(delays, []);
});

test("SDK cancellation also aborts the Android browser fallback without retrying", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 600000 ? 1 : delay, ...args)
  );
  let nativeRequests = 0;
  let browserRequests = 0;
  let browserAborted = false;
  const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
    Platform: { isAndroidApp: true },
    requestUrl: async () => {
      nativeRequests++;
      throw new Error("Request Failed. IllegalArgumentException Invalid input to toASCII: synthetic_host.example");
    },
  }, {
    fetch: async (_, { signal }) => {
      browserRequests++;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          browserAborted = true;
          reject(new DOMException("Request aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  await assert.rejects(openAiTranscription({
    ...settings, requestStreaming: false, retryTransientErrors: true,
  }, [image]), (error) => {
    assert.match(formatModelError(error), /timed out.*not automatically retried/);
    return true;
  });
  assert.equal(nativeRequests, 1);
  assert.equal(browserRequests, 1);
  assert.equal(browserAborted, true);
});

test("Android fallback preserves HTTP error classification and completion requirements", async () => {
  for (const [result, expected, attempts] of [
    [response(401, { error: { code: "invalid_api_key", message: "Invalid key" } }), /authentication failed/, 1],
    [response(429, { error: { code: "insufficient_quota", message: "No credits" } }), /Not enough API credits/, 1],
    [response(413, { error: { message: "Too large" } }), /HTTP 413/, 1],
    [response(503, { error: { code: "overloaded", message: "Busy" } }), /HTTP 503/, 3],
    [streamResponse([{ choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }] }], false), /stream ended before completion/, 3],
  ]) {
    let browserRequests = 0;
    const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
      Platform: { isAndroidApp: true },
      requestUrl: async () => { throw new Error("IllegalArgumentException Invalid input to toASCII"); },
    }, {
      ...retryTimers(),
      fetch: async () => {
        browserRequests++;
        return new Response(result.text, { status: result.status, headers: result.headers });
      },
    });
    await assert.rejects(openAiTranscription({
      ...settings, requestStreaming: result.status === 200, retryTransientErrors: true,
    }, [image]), (error) => {
      assert.match(formatModelError(error), expected);
      return true;
    });
    assert.equal(browserRequests, attempts);
  }
});

test("mobile upload and gateway errors are distinguished from authentication and credit failures", async () => {
  for (const [status, expected] of [
    [403, /gateway denied.*HTTP 403.*different network/],
    [408, /receiving the request.*HTTP 408.*Downscale images for LLM/],
    [413, /too large.*HTTP 413.*not automatically retried/],
  ]) {
    let requests = 0;
    const { openAiTranscription, formatModelError } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => { requests++; return response(status, { error: { message: "Request failed" } }); },
    });
    await assert.rejects(openAiTranscription({ ...settings, requestStreaming: false }, [image]), (error) => {
      assert.match(formatModelError(error), expected);
      return true;
    });
    assert.equal(requests, 1);
  }
});

for (const status of [524, 504]) {
  test(`bodyless HTTP ${status} reports a provider timeout without retrying or modifying the note`, async () => {
    let requests = 0;
    const fixture = pluginFixture(async () => {
      requests++;
      return { status, headers: {}, text: "" };
    });
    const original = fixture.getNote();
    await fixture.plugin.processImagesInCurrentNote();
    assert.equal(requests, 1);
    assert.equal(fixture.getNote(), original);
    const notice = fixture.notices.at(-1);
    assert.match(notice, new RegExp(`gateway timed out \\(HTTP ${status}\\)`));
    assert.match(notice, /faster vision model/);
    assert.match(notice, /Downscale images for LLM/);
    assert.match(notice, /check provider usage/);
  });
}

test("invalid provider configuration and unsupported image input never send a request", async () => {
  const { openAiTranscription, validateBaseUrl } = loadSource("src/services/openaiService.ts", {
    requestUrl: () => { assert.fail("Invalid input must not be sent"); },
  });
  for (const url of ["", "invalid", "file:///tmp/test", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#fragment", "https://example.com/v1/chat/completions"]) {
    assert.throws(() => validateBaseUrl(url), /API base URL/);
  }
  await assert.rejects(openAiTranscription({ ...settings, openaiApiKey: " " }, [image]), /API key/);
  await assert.rejects(openAiTranscription({ ...settings, openaiModel: " " }, [image]), /model ID/);
  await assert.rejects(openAiTranscription(settings, []), /No images/);
  await assert.rejects(openAiTranscription(settings, [{ ...image, dataUrl: "data:image/heic;base64,AQID" }]), /Unsupported model image format/);
});

test("empty, malformed, refused, and truncated results are rejected", async () => {
  for (const body of [
    {},
    { choices: [] },
    { choices: [{ message: { content: null, refusal: "Cannot process" } }] },
    JSON.parse(jsonCompletion("", "stop").text),
    JSON.parse(jsonCompletion("Partial text", "length").text),
    JSON.parse(jsonCompletion(null, "content_filter").text),
  ]) {
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => response(200, body),
    });
    await assert.rejects(openAiTranscription({ ...settings, requestStreaming: false }, [image]), /no transcription|declined|output limit/);
  }
});

class FileReaderMock {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload();
    });
  }
}

test("original JPEG/PNG/WEBP/GIF images retain their MIME types", async () => {
  const { prepareForProcessing } = loadSource("src/services/imagePrep.ts", {}, { FileReader: FileReaderMock });
  const app = { vault: { readBinary: async () => new Uint8Array([1, 2, 3]).buffer } };
  for (const [extension, mime] of [["jpg", "image/jpeg"], ["JPEG", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"], ["gif", "image/gif"]]) {
    const result = await prepareForProcessing(app, { name: `page.${extension}` }, true, false);
    assert.equal(result.llmDataUrl, `data:${mime};base64,AQID`);
    assert.equal(result.ocrBytes, undefined);
  }
});

test("HEIC conversion is lazy, shared with vault conversion, and reports failures", async () => {
  let conversions = 0;
  let mode = "single";
  const converter = async () => {
    conversions++;
    if (mode === "fail") throw new Error("HEIC conversion failed");
    const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
    return mode === "multiple" ? [jpeg, jpeg] : jpeg;
  };
  const { prepareForProcessing } = loadSource("src/services/imagePrep.ts", {}, { FileReader: FileReaderMock }, { heic2any: converter });
  const app = { vault: { readBinary: async () => new TextEncoder().encode("....ftypheic....").buffer } };
  await assert.rejects(prepareForProcessing(app, { name: "page.heic" }, false, false), /Enable Convert HEIC/);
  assert.equal(conversions, 0);
  const result = await prepareForProcessing(app, { name: "page.jpg" }, true, false);
  assert.match(result.llmDataUrl, /^data:image\/jpeg;base64,/);
  mode = "fail";
  await assert.rejects(prepareForProcessing(app, { name: "page.heic" }, true, false), /HEIC conversion failed/);
  mode = "multiple";
  await assert.rejects(prepareForProcessing(app, { name: "page.heic" }, true, false), /multiple images/);
});

test("downscaling respects the 2048-pixel threshold and white JPEG background", async () => {
  let white = false;
  const canvas = {
    getContext: () => ({
      set fillStyle(value) { white = value === "#ffffff"; },
      fillRect() {}, drawImage() {},
    }),
    toBlob: (callback, type) => callback(new Blob(["resized"], { type })),
  };
  class ImageMock {
    naturalWidth = 4096; naturalHeight = 2048;
    set src(value) { this.onload(); }
  }
  const { prepareForProcessing } = loadSource("src/services/imagePrep.ts", {}, {
    FileReader: FileReaderMock, Image: ImageMock, document: { createElement: () => canvas },
  });
  const result = await prepareForProcessing(
    { vault: { readBinary: async () => new Uint8Array([1]).buffer } },
    { name: "page.png" }, true, true
  );
  assert.equal(canvas.width, 2048);
  assert.equal(canvas.height, 1024);
  assert.equal(white, true);
  assert.match(result.llmDataUrl, /^data:image\/jpeg;base64,/);
});

function pluginFixture(requestUrl, converter, globals = {}, dependencies = {}) {
  const notices = [];
  const progress = [];
  class TFile {
    constructor(path) {
      this.path = path; this.name = path.split("/").pop();
      this.extension = this.name.split(".").pop();
      this.basename = this.name.slice(0, -(this.extension.length + 1));
    }
  }
  class Progress {
    start(message) { progress.push(message); }
    set(message) { progress.push(message); }
    setProgress(current, total, message) { progress.push(message); }
    fail(message) { notices.push(message); }
    done(message) { notices.push(message); }
    dispose() {}
  }
  const obsidian = {
    Plugin: class { constructor(app) { this.app = app; } },
    TFile, PluginSettingTab: class {},
    Notice: class { constructor(message) { notices.push(message); } },
    normalizePath: (path) => path,
    requestUrl,
  };
  const PluginClass = loadSource("src/main.ts", obsidian, {
    FileReader: FileReaderMock, console: { error() {}, warn() {} }, ...globals,
  }, { "./services/progress": { ProgressService: Progress }, heic2any: converter, ...dependencies }).default;
  const note = new TFile("note.md");
  const page = new TFile("page.jpg");
  const entity = new TFile("Roa.md");
  const files = new Map([[page.path, page], [entity.path, entity]]);
  const binary = new Map();
  let noteText = "![[page.jpg]]\nOriginal note";
  const app = {
    workspace: { getActiveFile: () => note },
    metadataCache: {
      getFileCache: (file) => file === note ? {
        embeds: Array.from(noteText.matchAll(/!\[\[([^\]]+)\]\]/g), (match) => ({
          link: match[1], position: { start: { offset: match.index }, end: { offset: match.index + match[0].length } },
        })),
      } : {},
      getFirstLinkpathDest: (path) => files.get(path),
      fileToLinktext: (file) => file.path,
    },
    vault: {
      readBinary: async (file) => binary.get(file.path) ?? new Uint8Array([1, 2, 3]).buffer,
      read: async () => noteText,
      modify: async (_, text) => { noteText = text; },
      process: async (file, update) => { assert.equal(file, note); noteText = update(noteText); },
      adapter: { exists: async (path) => files.has(path) },
      getAbstractFileByPath: (path) => files.get(path),
      getMarkdownFiles: () => [note, entity],
      createBinary: async (path, bytes) => {
        const file = new TFile(path); files.set(path, file); binary.set(path, bytes); return file;
      },
    },
  };
  const plugin = new PluginClass(app);
  Object.assign(plugin.settings, settings);
  return {
    plugin, notices, progress, files, TFile,
    getNote: () => noteText, setNote: (text) => { noteText = text; },
  };
}

test("migration preserves existing context, mobile progress, entity and HEIC settings", async () => {
  const { plugin } = pluginFixture();
  const saved = {
    openaiApiKey: "existing-key",
    azureApiKey: "old-secret", azureEndpoint: "old-endpoint",
    personalContext: "Roa is my son.", autoLinkEntities: true,
    replaceHeicEmbedsInNote: false, convertHeicToJpeg: false,
    imageLimit: 3, showFloatingToastProgress: true, overlayProgressPosition: "bottom",
  };
  plugin.loadData = async () => saved;
  let persisted;
  plugin.saveData = async (value) => { persisted = value; };
  await plugin.loadSettings();
  for (const key of ["openaiApiKey", "personalContext", "autoLinkEntities", "replaceHeicEmbedsInNote", "convertHeicToJpeg", "imageLimit", "showFloatingToastProgress", "overlayProgressPosition"]) {
    assert.equal(persisted[key], saved[key]);
  }
  assert.equal(persisted.azureApiKey, undefined);
  assert.equal(persisted.azureEndpoint, undefined);
  assert.equal(persisted.openaiBaseUrl, "https://api.openai.com/v1");
  assert.equal(persisted.openaiModel, "gpt-4o");
  assert.equal(persisted.requestStreaming, false);
  assert.equal(persisted.retryTransientErrors, true);
  assert.equal(persisted.cleanInvisibleCharacters, true);
  plugin.loadData = async () => ({ ...saved, requestStreaming: true, cleanInvisibleCharacters: false });
  await plugin.loadSettings();
  assert.equal(plugin.settings.requestStreaming, true);
  assert.equal(plugin.settings.cleanInvisibleCharacters, false);
});

test("vision transcription preserves concurrent edits, context, and entity auto-linking", async () => {
  let resolveRequest;
  let startRequest;
  const started = new Promise((resolve) => { startRequest = resolve; });
  let request;
  const fixture = pluginFixture(async (input) => {
    request = input;
    return new Promise((resolve) => { resolveRequest = resolve; startRequest(); });
  });
  fixture.plugin.settings.personalContext = "Roa is my son.";
  fixture.plugin.settings.autoLinkEntities = true;
  const pending = fixture.plugin.processImagesInCurrentNote();
  await fixture.plugin.processImagesInCurrentNote();
  await fixture.plugin.convertHeicToJpegInCurrentNote();
  await started;
  fixture.setNote("Edited while transcribing");
  resolveRequest(completion("Roa wrote a note."));
  await pending;
  assert.match(JSON.parse(request.body).messages[0].content, /Roa is my son/);
  assert.match(fixture.getNote(), /^## Longhand transcription/);
  assert.match(fixture.getNote(), /\[\[Roa\]\] wrote a note/);
  assert.match(fixture.getNote(), /\n\n---\n\nEdited while transcribing$/);
  assert.equal(fixture.notices.filter((message) => /already processing/.test(message)).length, 2);
  assert.doesNotMatch(fixture.progress.join("\n"), /OCR/);
});

test("quota failure leaves the note unchanged and permits a subsequent command", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => {
    requests++;
    return response(429, { error: { code: "insufficient_quota", message: "Quota exceeded" } });
  });
  const original = fixture.getNote();
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.getNote(), original);
  assert.match(fixture.notices.at(-1), /Not enough API credits/);
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 2);
});

test("existing users send JSON by default unless they explicitly opt in to streaming", async () => {
  let request;
  const fixture = pluginFixture(async (input) => { request = input; return jsonCompletion("JSON transcription"); });
  fixture.plugin.loadData = async () => ({ openaiApiKey: "test-key", replaceHeicEmbedsInNote: false });
  fixture.plugin.saveData = async () => {};
  await fixture.plugin.loadSettings();
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.plugin.settings.requestStreaming, false);
  assert.equal(JSON.parse(request.body).stream, undefined);
  assert.match(fixture.getNote(), /JSON transcription/);
});

test("HEIC replacement remains functional and preserves the original vault image", async () => {
  let request;
  const fixture = pluginFixture(async (input) => { request = input; return completion(); },
    async () => new Blob(["jpeg"], { type: "image/jpeg" })
  );
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]");
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.files.has("photo.heic"), true);
  assert.equal(fixture.files.has("photo.jpg"), true);
  assert.match(fixture.getNote(), /!\[\[photo.jpg\]\]/);
  assert.match(JSON.parse(request.body).messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("preparation failure is visible and avoids a provider request", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => { requests++; return completion(); });
  fixture.plugin.app.vault.readBinary = async () => { throw new Error("Image unavailable"); };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 0);
  assert.equal(fixture.notices.some((message) => /Skipped page.jpg: Image unavailable/.test(message)), true);
});

test("settings mask keys and persist endpoint/model without altering other options", async () => {
  const fields = [];
  const toggles = [];
  const notices = [];
  class Setting {
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    addText(callback) {
      const input = {
        inputEl: {}, setPlaceholder() { return this; }, setValue() { return this; },
        onChange(fn) { this.change = fn; return this; },
      };
      callback(input); fields.push({ name: this.name, input }); return this;
    }
    addToggle(callback) {
      const toggle = {
        setValue(value) { this.value = value; return this; },
        onChange(fn) { this.change = fn; return this; },
      };
      callback(toggle); toggles.push({ name: this.name, toggle }); return this;
    }
    addDropdown() { return this; } addTextArea() { return this; }
  }
  const { LonghandSettingTab, DEFAULT_SETTINGS } = loadSource("src/settings.ts", {
    Setting,
    PluginSettingTab: class { constructor() { this.containerEl = { empty() {}, createEl() {} }; } },
    Notice: class { constructor(message) { notices.push(message); } },
  });
  const current = { ...DEFAULT_SETTINGS, personalContext: "Roa", autoLinkEntities: true };
  let saves = 0;
  new LonghandSettingTab({}, {}, current, async () => { saves++; }).display();
  assert.equal(fields[0].input.inputEl.type, "password");
  await fields.find((field) => field.name === "API base URL").input.change(" https://openrouter.ai/api/v1/ ");
  await fields.find((field) => field.name === "Vision model").input.change(" openai/gpt-4o ");
  assert.equal(current.openaiBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(current.openaiModel, "openai/gpt-4o");
  assert.equal(current.personalContext, "Roa");
  assert.equal(current.autoLinkEntities, true);
  const streaming = toggles.find((field) => field.name === "Request streaming responses").toggle;
  assert.equal(streaming.value, false);
  await streaming.change(true);
  assert.equal(current.requestStreaming, true);
  const retries = toggles.find((field) => field.name === "Automatically retry temporary failures").toggle;
  assert.equal(retries.value, true);
  await retries.change(false);
  assert.equal(current.retryTransientErrors, false);
  const cleanup = toggles.find((field) => field.name === "Clean invisible characters in transcriptions").toggle;
  assert.equal(cleanup.value, true);
  await cleanup.change(false);
  assert.equal(current.cleanInvisibleCharacters, false);
  await fields.find((field) => field.name === "Image limit").input.change("0.5");
  assert.match(notices.at(-1), /positive integer/);
  assert.equal(current.imageLimit, 10);
  assert.equal(saves, 5);
});

function retryTimers(delays = []) {
  return {
    setTimeout(callback, delay) { delays.push(delay); queueMicrotask(callback); },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
  };
}

const transientIoError = (code = "EIO") => Object.assign(new Error(`Temporary I/O failure: ${code}`), { code });

test("temporary provider failures recover with bounded backoff and an unchanged payload", async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 524]) {
    const requests = [];
    const delays = [];
    const retries = [];
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async (request) => {
        requests.push(request);
        return requests.length < 3
          ? response(status, { error: { code: status === 429 ? "rate_limit_exceeded" : "upstream_error", message: "Temporarily unavailable" } })
          : jsonCompletion("Recovered");
      },
    }, retryTimers(delays));
    assert.equal(await openAiTranscription(
      { ...settings, requestStreaming: false, retryTransientErrors: true }, [image], undefined,
      (info) => retries.push(info)
    ), "Recovered");
    assert.equal(requests.length, 3);
    assert.deepEqual(delays, [2000, 4000]);
    assert.deepEqual(retries.map(({ attempt, maxAttempts }) => [attempt, maxAttempts]), [[2, 3], [3, 3]]);
    assert.equal(new Set(requests.map((request) => request.body)).size, 1);
  }
});

test("network interruption recovers without SDK retries multiplying the attempts", async () => {
  let requests = 0;
  const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
    requestUrl: async () => {
      requests++;
      if (requests === 1) throw transientIoError("ECONNRESET");
      return jsonCompletion("Recovered connection");
    },
  }, retryTimers());
  assert.equal(await openAiTranscription(
    { ...settings, requestStreaming: false, retryTransientErrors: true }, [image]
  ), "Recovered connection");
  assert.equal(requests, 2);
});

test("Retry-After seconds, dates, and milliseconds are honored without unbounded waits", async () => {
  const now = Date.now();
  for (const [headers, expectedDelay, attempts] of [
    [{ "Retry-After": "10" }, 10000, 2],
    [{ "retry-after": new Date(now + 15000).toUTCString() }, null, 2],
    [{ "retry-after-ms": "7000" }, 7000, 2],
    [{ "retry-after": "120" }, null, 1],
    [{ "retry-after": "invalid" }, 2000, 2],
  ]) {
    let requests = 0;
    const delays = [];
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => {
        requests++;
        return requests === 1
          ? { ...response(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } }), headers }
          : jsonCompletion("Recovered");
      },
    }, { ...retryTimers(delays), Date: class extends Date { static now() { return now; } } });
    const promise = openAiTranscription({ ...settings, requestStreaming: false, retryTransientErrors: true }, [image]);
    if (attempts === 1) {
      await assert.rejects(promise, /Too many requests/);
      assert.deepEqual(delays, []);
    } else {
      assert.equal(await promise, "Recovered");
      if (expectedDelay !== null) assert.deepEqual(delays, [expectedDelay]);
      else assert.deepEqual(delays, [Date.parse(headers["retry-after"]) - now]);
    }
    assert.equal(requests, attempts);
  }
});

test("permanent provider errors are not retried even when retries are enabled", async () => {
  for (const [status, code, message] of [
    [429, "insufficient_quota", "Quota exceeded"],
    [429, null, "Insufficient balance"],
    [429, null, "Too many failed authentication attempts"],
    [402, null, "Payment required"],
    [403, "insufficient_credits", "No credits"],
    [401, "invalid_api_key", "Invalid key"],
    [404, "model_not_found", "Unknown model"],
    [400, "invalid_image", "Invalid image"],
    [503, "billing_hard_limit_reached", "Billing limit"],
  ]) {
    let requests = 0;
    const delays = [];
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => { requests++; return response(status, { error: { code, message } }); },
    }, retryTimers(delays));
    await assert.rejects(openAiTranscription({ ...settings, retryTransientErrors: true }, [image]));
    assert.equal(requests, 1);
    assert.deepEqual(delays, []);
  }
});

test("incomplete streams retry from scratch without inserting partial text or changing mode", async () => {
  let requests = 0;
  const fixture = pluginFixture(async (request) => {
    requests++;
    assert.equal(JSON.parse(request.body).stream, true);
    return requests === 1
      ? streamResponse([{ choices: [{ index: 0, delta: { content: "Partial discarded text" }, finish_reason: null }] }], false)
      : completion("Complete transcription");
  }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 2);
  assert.doesNotMatch(fixture.getNote(), /Partial discarded/);
  assert.match(fixture.getNote(), /Complete transcription/);
  assert.equal((fixture.getNote().match(/## Longhand transcription/g) ?? []).length, 1);
  assert.match(fixture.progress.join("\n"), /retry 2\/3 in 2s/);
});

test("stream error events retry only transient failures, not insufficient credits", async () => {
  for (const [field, code, retries] of [
    ["stream_error", "generation_failed", true],
    ["error", "upstream_timeout", true],
    ["stream_error", "insufficient_quota", false],
    ["error", "insufficient_quota", false],
  ]) {
    let requests = 0;
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => ++requests === 1
        ? streamResponse([{ [field]: { code, message: code } }])
        : completion("Recovered stream"),
    }, retryTimers());
    const promise = openAiTranscription({ ...settings, retryTransientErrors: true }, [image]);
    if (retries) assert.equal(await promise, "Recovered stream");
    else await assert.rejects(promise);
    assert.equal(requests, retries ? 2 : 1);
  }
});

test("empty, refused, limited, and incompatible responses are not retried", async () => {
  for (const result of [completion(""), completion("Partial", "length"), completion(null, "content_filter"), jsonCompletion()]) {
    let requests = 0;
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => { requests++; return result; },
    }, retryTimers());
    await assert.rejects(openAiTranscription({ ...settings, retryTransientErrors: true }, [image]));
    assert.equal(requests, 1);
  }
});

test("exhausted retries leave the note unchanged, report attempts, and release the command guard", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => {
    requests++;
    return { status: 524, headers: {}, text: "" };
  }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  const original = fixture.getNote();
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 3);
  assert.equal(fixture.getNote(), original);
  assert.match(fixture.notices.at(-1), /Failed after 3 attempts.*HTTP 524/);
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 6);
});

test("transient note and image reads recover without repeating successful preparation", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => { requests++; return completion(); }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  let reads = 0;
  const read = fixture.plugin.app.metadataCache.getFileCache;
  fixture.plugin.app.metadataCache.getFileCache = (...args) => {
    if (++reads === 1) throw transientIoError("EBUSY");
    return read(...args);
  };
  let binaryReads = 0;
  const readBinary = fixture.plugin.app.vault.readBinary;
  fixture.plugin.app.vault.readBinary = async (...args) => {
    if (++binaryReads === 1) throw transientIoError();
    return readBinary(...args);
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(reads, 2);
  assert.equal(binaryReads, 2);
  assert.equal(requests, 1);
  assert.match(fixture.getNote(), /Transcription/);
});

test("retrying a failed note write reuses model output and preserves concurrent edits", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => { requests++; return completion(); }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (...args) => {
    if (++writes === 1) {
      fixture.setNote("Concurrent edit");
      throw transientIoError();
    }
    return process(...args);
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(writes, 2);
  assert.equal(requests, 1);
  assert.match(fixture.getNote(), /---\n\nConcurrent edit$/);
});

test("a note write that succeeds before throwing is not duplicated on retry", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => { requests++; return completion(); }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (...args) => {
    await process(...args);
    if (++writes === 1) {
      fixture.setNote(`Another section\n\n${fixture.getNote()}`);
      throw transientIoError();
    }
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(writes, 2);
  assert.equal(requests, 1);
  assert.equal((fixture.getNote().match(/## Longhand transcription/g) ?? []).length, 1);
  assert.match(fixture.getNote(), /^Another section/);
});

test("a JPEG creation that succeeds before throwing reuses the file without reconversion", async () => {
  let conversions = 0;
  const fixture = pluginFixture(async () => completion(), async () => {
    conversions++;
    return new Blob(["jpeg"], { type: "image/jpeg" });
  }, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]");
  const create = fixture.plugin.app.vault.createBinary;
  let creates = 0;
  fixture.plugin.app.vault.createBinary = async (...args) => {
    const file = await create(...args);
    if (++creates === 1) throw transientIoError();
    return file;
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(conversions, 1);
  assert.equal(creates, 1);
  assert.equal(fixture.files.has("photo.jpg"), true);
  assert.equal(fixture.files.has("photo (1).jpg"), false);
  assert.match(fixture.getNote(), /!\[\[photo.jpg\]\]/);
});

test("retrying an already-applied HEIC embed rewrite does not corrupt the note", async () => {
  const fixture = pluginFixture(async () => completion(),
    async () => new Blob(["jpeg"], { type: "image/jpeg" }), retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]\nOriginal note");
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (...args) => {
    await process(...args);
    if (++writes === 1) throw transientIoError();
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.match(fixture.getNote(), /!\[\[photo.jpg\]\]\nOriginal note$/);
  assert.equal(writes, 3);
});

test("permanent vault errors are reported without retrying or making a model request", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => { requests++; return completion(); }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  let reads = 0;
  fixture.plugin.app.vault.readBinary = async () => {
    reads++;
    throw transientIoError("ENOENT");
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(reads, 1);
  assert.equal(requests, 0);
  assert.match(fixture.notices.join("\n"), /Skipped page.jpg/);
});

test("model retries reuse prepared images and preserve edits made while waiting", async () => {
  let requests = 0;
  const fixture = pluginFixture(async () => {
    if (++requests === 1) {
      fixture.setNote("Edited during provider failure");
      return response(503, { error: { message: "Overloaded" } });
    }
    return completion("Recovered transcription");
  }, undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  let reads = 0;
  const read = fixture.plugin.app.vault.readBinary;
  fixture.plugin.app.vault.readBinary = (...args) => { reads++; return read(...args); };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(requests, 2);
  assert.equal(reads, 1);
  assert.match(fixture.getNote(), /Recovered transcription\n\n---\n\nEdited during provider failure$/);
});

test("editing inserted text after an ambiguous write stops retries instead of duplicating it", async () => {
  const fixture = pluginFixture(async () => completion("Original transcription"), undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (...args) => {
    await process(...args);
    if (++writes === 1) {
      fixture.setNote(fixture.getNote().replace("Original transcription", "User-edited transcription"));
      throw transientIoError();
    }
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal((fixture.getNote().match(/## Longhand transcription/g) ?? []).length, 1);
  assert.match(fixture.getNote(), /User-edited transcription/);
  assert.match(fixture.notices.at(-1), /note changed after a failed write/);
});

test("HEIC rewrites preserve edits made after an ambiguous successful write", async () => {
  const fixture = pluginFixture(undefined, async () => new Blob(["jpeg"], { type: "image/jpeg" }), retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]");
  const process = fixture.plugin.app.vault.process;
  fixture.plugin.app.vault.process = async (...args) => {
    await process(...args);
    fixture.setNote(`Concurrent edit\n${fixture.getNote()}`);
    throw transientIoError();
  };
  await fixture.plugin.convertHeicToJpegInCurrentNote();
  assert.equal(fixture.getNote(), "Concurrent edit\n![[photo.jpg]]");
  assert.match(fixture.notices.at(-1), /note changed while replacing HEIC embeds/);
});

test("JPEG retries never overwrite a conflicting file or create a second path", async () => {
  const fixture = pluginFixture();
  const heic = new fixture.TFile("photo.heic");
  const create = fixture.plugin.app.vault.createBinary;
  let creates = 0;
  fixture.plugin.app.vault.createBinary = async (path) => {
    creates++;
    await create(path, new TextEncoder().encode("Another user's file").buffer);
    throw transientIoError();
  };
  const { convertHeicVaultFileToJpeg } = loadSource("src/services/heicReplace.ts", {
    TFile: fixture.TFile, normalizePath: (path) => path,
  }, retryTimers(), { heic2any: async () => new Blob(["jpeg"], { type: "image/jpeg" }) });
  await assert.rejects(convertHeicVaultFileToJpeg(fixture.plugin.app, heic), /already contains different data/);
  assert.equal(creates, 1);
  assert.equal(fixture.files.has("photo (1).jpg"), false);
  const bytes = await fixture.plugin.app.vault.readBinary(fixture.files.get("photo.jpg"));
  assert.equal(new TextDecoder().decode(bytes), "Another user's file");
});

test("standalone HEIC conversion reports missing notes and exhausted failures accurately", async () => {
  const fixture = pluginFixture(undefined, async () => { throw new Error("Unsupported HEIC"); }, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  const activeFile = fixture.plugin.app.workspace.getActiveFile;
  fixture.plugin.app.workspace.getActiveFile = () => null;
  await fixture.plugin.convertHeicToJpegInCurrentNote();
  assert.equal(fixture.notices.at(-1), "No active note.");
  fixture.plugin.app.workspace.getActiveFile = activeFile;
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]");
  await fixture.plugin.convertHeicToJpegInCurrentNote();
  assert.match(fixture.notices.at(-1), /1 HEIC conversion\(s\) failed/);
  assert.equal(fixture.getNote(), "![[photo.heic]]");
});

test("retry jitter stays within its bounds and repeated I/O failures stop after three attempts", async () => {
  const delays = [];
  const { withRetry } = loadSource("src/services/retry.ts", {}, {
    ...retryTimers(delays), Math: Object.assign(Object.create(Math), { random: () => 0.999 }),
  });
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; throw transientIoError(); }), /Failed after 3 attempts/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2999, 4999]);
});

test("an existing identical transcription is not mistaken for a successful retried write", async () => {
  const fixture = pluginFixture(async () => completion("Same transcription"), undefined, {
    ...retryTimers(),
    Date: class extends Date { constructor() { super("2026-01-01T12:00:00Z"); } },
  });
  fixture.plugin.settings.retryTransientErrors = true;
  await fixture.plugin.processImagesInCurrentNote();
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (file, update) => {
    if (++writes === 1) {
      update(fixture.getNote());
      throw transientIoError();
    }
    return process(file, update);
  };
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(writes, 2);
  assert.equal((fixture.getNote().match(/## Longhand transcription/g) ?? []).length, 2);
});

test("HEIC rewrites refresh link offsets after a retried read instead of corrupting edits", async () => {
  const fixture = pluginFixture(undefined, async () => new Blob(["jpeg"], { type: "image/jpeg" }), retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.files.set("photo.heic", new fixture.TFile("photo.heic"));
  fixture.setNote("![[photo.heic]]");
  const read = fixture.plugin.app.vault.read;
  let reads = 0;
  fixture.plugin.app.vault.read = async (...args) => {
    if (++reads === 1) {
      fixture.setNote("New introduction\n![[photo.heic]]");
      throw transientIoError();
    }
    return read(...args);
  };
  await fixture.plugin.convertHeicToJpegInCurrentNote();
  assert.equal(reads, 2);
  assert.equal(fixture.getNote(), "New introduction\n![[photo.jpg]]");
});

const { cleanInvisibleCharacters } = loadSource("src/services/textCleanup.ts");

test("prose cleanup removes exactly the selected invisible characters without normalizing whitespace", () => {
  const source = "\uFEFFCaf\u00E9\u200B soft\u00ADhyphen word\u2060joiner.\r\n\r\nNext\tline  \n";
  const result = cleanInvisibleCharacters(source);
  assert.equal(result.text, "Caf\u00E9 softhyphen wordjoiner.\r\n\r\nNext\tline  \n");
  assert.equal(result.removedCount, 4);
  const again = cleanInvisibleCharacters(result.text);
  assert.equal(again.text, result.text);
  assert.equal(again.removedCount, 0);
});

test("cleanup preserves all ASCII, international writing, typography and meaningful invisible controls", () => {
  for (const source of [
    Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join(""),
    "Caf\u00E9, na\u00EFve, e\u0301, \u4F60\u597D, \u03BA\u03CC\u03C3\u03BC\u03BF\u03C2",
    "\u0645\u06CC\u200C\u0631\u0648\u0645 \u0915\u094D\u200D\u0937 \u200F\u05E9\u05DC\u05D5\u05DD\u200E",
    "A\u200CB\u200DC \u2066RTL\u2069 \u202ALTR\u202C",
    "A\u00A0B\u202FC\u2009D \u201Cquotes\u201D \u2014 \u2026",
    "\u115F\u1160\u3164\u034F\u180B\u2061\u2062\u2063\u2064\u{E0100}",
  ]) {
    const result = cleanInvisibleCharacters(source);
    assert.equal(result.text, source);
    assert.equal(result.removedCount, 0);
  }
});

test("cleanup preserves complete emoji sequences including joiners, modifiers, keycaps and tags", () => {
  const emojis = [
    "\u{1F469}\u{1F3FD}\u200D\u{1F52C}",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
    "\u2764\uFE0F 1\uFE0F\u20E3 \u00A9\uFE0F \u2600\uFE0E",
    "\u{1F1FA}\u{1F1F8} \u{1F3F3}\uFE0F\u200D\u{1F308}",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  ].join(" ");
  const result = cleanInvisibleCharacters(`Before\u200B ${emojis} after\u2060.`);
  assert.equal(result.text, `Before ${emojis} after.`);
  assert.equal(result.removedCount, 2);
});

test("cleanup preserves fenced, indented, inline and nested Markdown code", () => {
  for (const code of [
    "```text\nliteral\u200B\u2060\u00AD\uFEFF\n```",
    "~~~~text\nliteral\u200B\n~~~~",
    "````text\n```\nliteral\u200B\n````",
    "    indented\u200B\n    literal\u00AD",
    "> ```text\n> literal\u200B\n> ```",
    "- ```text\n  literal\u200B\n  ```",
    "Inline `literal\u200B` and ``literal\u2060`tick``.",
  ]) {
    const result = cleanInvisibleCharacters(`Before\u200B\n\n${code}\n\nAfter\u2060`);
    assert.equal(result.text, `Before\n\n${code}\n\nAfter`);
    assert.equal(result.removedCount, 2);
  }
});

test("frontmatter, including BOMs, CRLF, alternate closers and unfinished blocks, is preserved", () => {
  for (const frontmatter of [
    "---\nname: 'literal\u200B'\nalias: 'word\u2060'\n---\n",
    "\uFEFF---\r\nname: 'literal\u200B'\r\n--- \r\n",
    "---\nname: 'literal\u200B'\n...\n",
  ]) {
    const result = cleanInvisibleCharacters(`${frontmatter}Prose\u200B`);
    assert.equal(result.text, `${frontmatter}Prose`);
    assert.equal(result.removedCount, 1);
  }
  const unfinished = "---\nname: 'literal\u200B'\nunfinished\u2060";
  assert.equal(cleanInvisibleCharacters(unfinished).text, unfinished);
  assert.equal(cleanInvisibleCharacters(unfinished).removedCount, 0);
});

test("links, wiki targets, images, reference identifiers, URLs and HTML are preserved", () => {
  for (const syntax of [
    "[label\u200B](folder/note\u2060.md \"title\u00AD\")",
    "![alt\u200B](image\u2060.png)",
    "[[note\u200B|alias\u2060]] and ![[image\u00AD.png|100]]",
    "[ref\u200B]: /target\u2060 \"title\u00AD\"\n\n[ref\u200B]",
    "<https://example.com/path\u200B> and https://example.com/path\u2060",
    "<div data-value=\"literal\u200B\">\nliteral\u2060\n</div>",
    "<!-- literal\u200B -->",
    "Inline <!-- literal\u200B --> comment",
  ]) {
    const result = cleanInvisibleCharacters(`Before\u200B\n\n${syntax}\n\nAfter\u2060`);
    assert.equal(result.text, `Before\n\n${syntax}\n\nAfter`);
    assert.equal(result.removedCount, 2);
  }
});

test("inline HTML preserves attributes while cleaning surrounding prose", () => {
  const source = 'Text\u200B <span data-value="literal\u2060">content\u00AD</span> after\uFEFF.';
  const result = cleanInvisibleCharacters(source);
  assert.equal(result.text, 'Text <span data-value="literal\u2060">content</span> after.');
  assert.equal(result.removedCount, 3);
});

test("a leading BOM does not prevent code protection, while the BOM itself is cleaned", () => {
  const result = cleanInvisibleCharacters("\uFEFF```text\nliteral\u200B\n```\n\nProse\u2060");
  assert.equal(result.text, "```text\nliteral\u200B\n```\n\nProse");
  assert.equal(result.removedCount, 2);
});

test("transcriptions are cleaned before entity linking without changing existing note content", async () => {
  const emoji = "\u{1F469}\u{1F3FD}\u200D\u{1F52C}";
  const fixture = pluginFixture(async () => completion(`R\u200Boa wrote a note\u2060 ${emoji}. \`literal\u200B\``));
  fixture.plugin.settings.autoLinkEntities = true;
  fixture.setNote("![[page.jpg]]\nOriginal\u200B note");
  await fixture.plugin.processImagesInCurrentNote();
  assert.match(fixture.getNote(), /\[\[Roa\]\] wrote a note /);
  assert.equal(fixture.getNote().includes(emoji), true);
  assert.equal(fixture.getNote().includes("`literal\u200B`"), true);
  assert.equal(fixture.getNote().endsWith("Original\u200B note"), true);
  assert.match(fixture.progress.join("\n"), /Cleaned 2 invisible character/);
});

test("automatic transcription cleanup can be disabled", async () => {
  const output = "Un\u200Btouched\u2060 text";
  const fixture = pluginFixture(async () => completion(output));
  fixture.plugin.settings.cleanInvisibleCharacters = false;
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.getNote().includes(output), true);
  assert.doesNotMatch(fixture.progress.join("\n"), /Cleaned/);
});

test("a response containing only removable characters is not inserted", async () => {
  const fixture = pluginFixture(async () => completion("\u200B\u2060\u00AD"));
  const original = fixture.getNote();
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.getNote(), original);
  assert.match(fixture.notices.at(-1), /no readable transcription after/);
});

test("the cleanup command is registered and works locally even with automatic cleanup disabled", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"));
  fixture.plugin.loadData = async () => ({ cleanInvisibleCharacters: false });
  fixture.plugin.saveData = async () => {};
  fixture.plugin.addSettingTab = () => {};
  const commands = [];
  fixture.plugin.addCommand = (command) => commands.push(command);
  await fixture.plugin.onload();
  const command = commands.find((entry) => entry.id === "longhand-clean-invisible-characters-in-current-note");
  assert.equal(command.name, "Clean invisible characters in current note");
  fixture.setNote("Clean\u200B me\u2060\n\n`literal\u200B`");
  await command.callback();
  assert.equal(fixture.getNote(), "Clean me\n\n`literal\u200B`");
  assert.match(fixture.notices.at(-1), /removed 2 invisible character/);
});

test("already-clean notes and protected-only characters do not cause a note write", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"));
  fixture.plugin.app.vault.process = () => assert.fail("No-op cleanup must not write");
  for (const source of ["Plain note", "`literal\u200B` and [[note\u2060]]"]) {
    fixture.setNote(source);
    await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
    assert.equal(fixture.getNote(), source);
    assert.match(fixture.notices.at(-1), /no removable invisible characters/);
  }
});

test("manual cleanup uses latest note content rather than clobbering concurrent edits", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"));
  fixture.setNote("Old\u200B text");
  const process = fixture.plugin.app.vault.process;
  fixture.plugin.app.vault.process = async (...args) => {
    fixture.setNote("Concurrent\u2060 edit \u{1F680}");
    return process(...args);
  };
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(fixture.getNote(), "Concurrent edit \u{1F680}");
});

test("a cleanup write that succeeds before throwing remains idempotent on retry", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"), undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.setNote("Clean\u200B me\u2060");
  const process = fixture.plugin.app.vault.process;
  let writes = 0;
  fixture.plugin.app.vault.process = async (...args) => {
    await process(...args);
    if (++writes === 1) {
      fixture.setNote(`Concurrent edit\n${fixture.getNote()}`);
      throw transientIoError();
    }
  };
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(writes, 2);
  assert.equal(fixture.getNote(), "Concurrent edit\nClean me");
  assert.match(fixture.notices.at(-1), /cleanup complete/);
});

test("cleanup reports permanent failures and releases the processing guard", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"), undefined, retryTimers());
  fixture.plugin.settings.retryTransientErrors = true;
  fixture.setNote("Clean\u200B me");
  const read = fixture.plugin.app.vault.read;
  let reads = 0;
  fixture.plugin.app.vault.read = async () => { reads++; throw transientIoError("EACCES"); };
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(reads, 1);
  assert.equal(fixture.getNote(), "Clean\u200B me");
  assert.match(fixture.notices.at(-1), /Failed to clean.*EACCES/);
  fixture.plugin.app.vault.read = read;
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(fixture.getNote(), "Clean me");
});

test("cleanup rejects missing notes and non-Markdown files without touching them", async () => {
  const fixture = pluginFixture(() => assert.fail("Cleanup must not call a provider"));
  fixture.plugin.app.vault.read = () => assert.fail("Invalid targets must not be read");
  const file = fixture.plugin.app.workspace.getActiveFile();
  fixture.plugin.app.workspace.getActiveFile = () => null;
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(fixture.notices.at(-1), "No active note.");
  fixture.plugin.app.workspace.getActiveFile = () => ({ ...file, extension: "png" });
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.match(fixture.notices.at(-1), /requires a Markdown note/);
});

test("cleanup is blocked while transcription is running", async () => {
  let resolve;
  let start;
  const started = new Promise((done) => { start = done; });
  const fixture = pluginFixture(async () => {
    start();
    return new Promise((done) => { resolve = done; });
  });
  const pending = fixture.plugin.processImagesInCurrentNote();
  await started;
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.match(fixture.notices.at(-1), /already processing/);
  resolve(completion());
  await pending;
});

test("parser failures during automatic or manual cleanup are visible and never replace note content", async () => {
  const fixture = pluginFixture(async () => completion("Model\u200B text"), undefined, {}, {
    "@lezer/markdown": {
      GFM: [],
      parser: { configure: () => ({ parse: () => { throw new Error("Simulated Markdown parser failure"); } }) },
    },
  });
  const original = fixture.getNote();
  await fixture.plugin.processImagesInCurrentNote();
  assert.equal(fixture.getNote(), original);
  assert.match(fixture.notices.at(-1), /Failed to clean transcription.*Simulated Markdown parser failure/);
  fixture.setNote("Note\u200B text");
  await fixture.plugin.cleanInvisibleCharactersInCurrentNote();
  assert.equal(fixture.getNote(), "Note\u200B text");
  assert.match(fixture.notices.at(-1), /Failed to clean invisible characters.*Simulated Markdown parser failure/);
});
