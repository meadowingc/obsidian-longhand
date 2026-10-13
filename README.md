# Longhand (Obsidian plugin)

Transcribes images in the current note directly with an OpenAI-compatible vision model.
Optionally converts HEIC to JPEG and rewrites embeds, downscales model input,
and auto-links existing note names in the Markdown transcription prepended to the note.
Azure Computer Vision OCR is no longer required.

## Requirements
- An API key from OpenAI or an OpenAI-compatible provider
- An image-capable model supporting Chat Completions
- Internet connectivity
- Node.js 18+ (for building from source)

## Installation

The recommended way to install this plugin is through [BRAT](https://github.com/TfTHacker/obsidian42-brat). 

## Install from source
1. Install dependencies `yarn install`
2. Build:
   - Dev (with sourcemap): `npm run dev` 
   - Production: `npm run build` 
3. In your vault, create folder: `<your vault>/.obsidian/plugins/longhand-obsidian/`
   - Or `git clone` the repository into directly under `<your vault>/.obsidian/plugins/`
4. Copy `manifest.json` and the built `main.js` into that folder.
5. Reload Obsidian and enable “Longhand” in Community Plugins.

Scripts:
- `dev`: esbuild bundle with sourcemap
- `build`: esbuild minified bundle
- `typecheck`: TypeScript checks
- `test`: regression tests
- `release`: `node scripts/release.js` (optional, for packaging)

## Usage
- Open a note that contains embedded images (`![[img.png]]` or `![alt](img.png)`).
- Run the command: “Longhand: Process images in current note”.
- The plugin:
  - Scans the note for images (order preserved; capped by Image limit)
  - Optionally converts HEIC/HEIF to JPEG and rewrites embeds to the JPEG
  - Sends prepared images (png/jpeg/webp/gif) directly to the configured vision model
  - Reports unsupported images and preparation failures rather than silently omitting them
  - Cleans selected invisible formatting characters from transcription prose
  - Prepends a section to the note:
    - `## Longhand transcription (YYYY-MM-DD HH:MM:SS)`
    - followed by the generated Markdown

## Settings
- Provider API key (masked in settings; stored unencrypted locally)
- API base URL (default `https://api.openai.com/v1`)
- Vision model (default `gpt-4o`)
- Request streaming responses (opt-in; disabled by default)
- Automatically retry temporary failures (enabled by default; up to two retries)
- Clean invisible characters in transcriptions (enabled by default)
- Convert HEIC to JPEG
- Replace HEIC embeds with JPEG in note
- Downscale images for LLM input (maximum edge of 2048 pixels)
- Image limit per run
- Show status bar progress
- Show start/finish notices (also final summary with duration)
- Show floating toast progress (mobile-friendly transient messages)
- Overlay progress bar position (Off / Top / Bottom)
- Auto-link entities in transcription (wikilink existing note names & aliases)
- Personal context (optional terms to reduce transcription mistakes)

## Custom providers and errors

For OpenRouter, use `https://openrouter.ai/api/v1`, your OpenRouter API key,
and an image-capable model ID such as `openai/gpt-4o`. Other compatible endpoints
can be configured the same way. Enter the API base URL, not the full
`/chat/completions` URL.

Requests use Obsidian's native network API on desktop and mobile, avoiding
browser CORS restrictions. Images and optional personal context are sent to
your configured provider; API keys stay in the local plugin settings.

Optional streaming requests let providers send incremental data instead of keeping the
connection idle until the entire transcription is ready. This can avoid gateway
idle timeouts such as HTTP 524 when the provider flushes output or keepalive data
often enough. It is not a guarantee: slow first output, uploads, provider outages,
or a buffering intermediary can still cause timeouts.
Obsidian buffers the response, so the note is updated only after a complete
transcription, not token by token. **Request streaming responses** is disabled
by default: enable it only after checking your endpoint and model support
streaming reliably. Some endpoints can stall in streaming mode even when JSON
requests succeed. Retries use the same response mode; there is no automatic fallback
between JSON and streaming.

Temporary connection failures, rate limits, gateway errors (including HTTP 504/524),
and interrupted streams are retried up to twice, with exponential backoff and jitter
(approximately 2–3 seconds, then 4–5 seconds). Provider `Retry-After` headers are
honored; waits longer than 60 seconds stop automatic retries instead of retrying
too early. Progress displays the next attempt and delay. Disable **Automatically
retry temporary failures** to make only one attempt.

Invalid credentials, insufficient credits/quota, invalid inputs, refusals, and
output-limit errors are not retried. The plugin's own request timeout is not
retried because Obsidian cannot reliably cancel the underlying native request.
**A failed or timed-out generation may still run or incur charges on the provider;
automatic retries can therefore cause multiple billable generations.** Check
provider usage after repeated failures.

Recoverable vault I/O errors are also retried during processing. Prepared images
and successful model output are reused, rather than restarting the entire command.
Note writes recognize already-inserted transcription, HEIC writes reuse the same
JPEG path and verify its bytes, and embed rewrites refuse to overwrite concurrent
note edits. If an ambiguous note-write failure is followed by edits to the inserted
text, processing stops rather than risking duplicate content. Unsupported formats
and deterministic conversion errors are not retried.

Existing OpenAI keys and other settings are preserved. Obsolete Azure OCR
credentials are removed from saved plugin settings. Insufficient credits/quota,
authentication errors, rate limits, and endpoint/model errors produce actionable
notices. A ChatGPT subscription does not include OpenAI API credits.

Failed, empty, refused, or truncated model responses are not inserted into the note.
Overlapping transcription commands are blocked to avoid duplicate requests.
Local OCR is not included; vision-only transcription needs no additional OCR
runtime on mobile.

## Invisible-character cleanup and text watermarks

New transcriptions are cleaned automatically unless **Clean invisible characters
in transcriptions** is disabled. For existing notes, run **Longhand: Clean invisible
characters in current note**. The command works locally without an API key or a
network request and processes the latest note content.

Cleanup removes only these characters from Markdown prose:
- `U+200B` ZERO WIDTH SPACE
- `U+2060` WORD JOINER
- `U+00AD` SOFT HYPHEN
- `U+FEFF` BOM / ZERO WIDTH NO-BREAK SPACE

Code blocks, inline code, frontmatter, links (including wiki links and images),
and raw HTML markup are preserved. Accented letters, non-Latin scripts, combining
marks, punctuation, ordinary/non-breaking spaces, and emoji sequences are not
ASCII-filtered or normalized. Emoji joiners, variation selectors, skin tones,
flags and tag sequences are retained, as are script joiners and bidirectional
formatting controls. The removed characters can also have legitimate line-breaking
uses, so disable automatic cleanup when those are intentional.

**This is not a universal AI watermark remover or an AI-detector bypass.**
[Google's documented SynthID Text watermark](https://deepmind.google/models/synthid/)
changes token probabilities, rather than inserting hidden Unicode characters.
Character cleanup cannot remove that kind of statistical watermark. The plugin
does not assume that OpenAI or Anthropic output contains invisible watermarks,
identify a text's origin, or rewrite the author's wording to evade detection.
[Unicode's explanation of invisible characters](https://www.unicode.org/faq/unsup_char.html)
also shows why removing all non-ASCII or all invisible characters would damage
legitimate writing and emoji.
