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
  - Prepends a section to the note:
    - `## Longhand transcription (YYYY-MM-DD HH:MM:SS)`
    - followed by the generated Markdown

## Settings
- Provider API key (masked in settings; stored unencrypted locally)
- API base URL (default `https://api.openai.com/v1`)
- Vision model (default `gpt-4o`)
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

Existing OpenAI keys and other settings are preserved. Obsolete Azure OCR
credentials are removed from saved plugin settings. Insufficient credits/quota,
authentication errors, rate limits, and endpoint/model errors produce actionable
notices. A ChatGPT subscription does not include OpenAI API credits.

Failed, empty, refused, or truncated model responses are not inserted into the note.
Overlapping transcription commands are blocked to avoid duplicate requests.
Local OCR is not included; vision-only transcription needs no additional OCR
runtime on mobile.
