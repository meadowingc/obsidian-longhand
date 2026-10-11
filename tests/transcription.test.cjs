const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const { runInNewContext } = require("node:vm");
const OpenAI = require("openai");

function loadSource(file, obsidian = {}, globals = {}, dependencies = {}) {
  const { outputFiles } = buildSync({
    entryPoints: [file], bundle: true, write: false, platform: "node", format: "cjs",
    supported: { "dynamic-import": false },
    external: ["obsidian", "openai", "heic2any", "./services/progress"],
  });
  const result = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module: result, exports: result.exports,
    require: (id) => id === "obsidian" ? obsidian : dependencies[id] ?? require(id),
    Request, Response, URL, Blob, Error, DOMException, console,
    ...globals,
  });
  return result.exports;
}

const settings = {
  openaiApiKey: "test-key",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o",
};
const image = { fileName: "page.jpg", alt: "handwriting", dataUrl: "data:image/jpeg;base64,/9j/" };
const response = (status, body) => ({
  status, headers: { "content-type": "application/json" }, text: JSON.stringify(body),
});
const completion = (content = "Transcription", reason = "stop") =>
  response(200, { choices: [{ finish_reason: reason, message: { role: "assistant", content } }] });

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
    assert.equal(body.messages[1].content[1].image_url.url, image.dataUrl);
    assert.equal(body.messages[1].content[2].image_url.url, "data:image/jpeg;base64,AQID");
    assert.match(body.messages[0].content, /My son's name is Roa/);
    assert.doesNotMatch(JSON.stringify(body), /OCR/);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, undefined);
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
    requestUrl: () => new Promise(() => {}),
  });
  await assert.rejects(openAiTranscription(settings, [image]), (error) => {
    assert.match(formatModelError(error), /timed out/);
    return true;
  });
  assert.match(formatModelError(new OpenAI.APIConnectionError({})), /network connection/);
});

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
    JSON.parse(completion("", "stop").text),
    JSON.parse(completion("Partial text", "length").text),
    JSON.parse(completion(null, "content_filter").text),
  ]) {
    const { openAiTranscription } = loadSource("src/services/openaiService.ts", {
      requestUrl: async () => response(200, body),
    });
    await assert.rejects(openAiTranscription(settings, [image]), /no transcription|declined|output limit/);
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

function pluginFixture(requestUrl, converter) {
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
    FileReader: FileReaderMock, console: { error() {}, warn() {} },
  }, { "./services/progress": { ProgressService: Progress }, heic2any: converter }).default;
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
  await started;
  fixture.setNote("Edited while transcribing");
  resolveRequest(completion("Roa wrote a note."));
  await pending;
  assert.match(JSON.parse(request.body).messages[0].content, /Roa is my son/);
  assert.match(fixture.getNote(), /^## Longhand transcription/);
  assert.match(fixture.getNote(), /\[\[Roa\]\] wrote a note/);
  assert.match(fixture.getNote(), /\n\n---\n\nEdited while transcribing$/);
  assert.equal(fixture.notices.some((message) => /already processing/.test(message)), true);
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
    addToggle() { return this; } addDropdown() { return this; } addTextArea() { return this; }
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
  await fields.find((field) => field.name === "Image limit").input.change("0.5");
  assert.match(notices.at(-1), /positive integer/);
  assert.equal(current.imageLimit, 10);
  assert.equal(saves, 2);
});
