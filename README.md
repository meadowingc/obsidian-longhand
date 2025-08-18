# Longhand (Obsidian plugin)

Processes images in the current note: runs Azure OCR, optionally converts HEIC to JPEG and rewrites embeds, then sends images (optionally downscaled) plus OCR text to OpenAI to produce a Markdown transcription that is prepended to the note.

## Requirements
- OpenAI API key
- Azure Computer Vision endpoint and key
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
- `release`: `node scripts/release.js` (optional, for packaging)

## Usage
- Open a note that contains embedded images (`![[img.png]]` or `![alt](img.png)`).
- Run the command: “Longhand: Process images in current note”.
- The plugin:
  - Scans the note for images (order preserved; capped by Image limit)
  - Optionally converts HEIC/HEIF to JPEG and rewrites embeds to the JPEG
  - Performs Azure OCR on each image
  - Sends usable images (png/jpeg/webp/gif) plus OCR text to OpenAI (gpt-4o)
  - Prepends a section to the note:
    - `## Longhand transcription (YYYY-MM-DD HH:MM:SS)`
    - followed by the generated Markdown

## Settings
- OpenAI API Key
- Azure Computer Vision Endpoint
- Azure Computer Vision Key
- Convert HEIC to JPEG (best-effort)
- Replace HEIC embeds with JPEG in note
- Downscale images for LLM input (OCR uses original resolution)
- Image limit per run
- Show status bar progress
- Show start/finish notices (also final summary with duration)
- Show floating toast progress (mobile-friendly transient messages)
- Overlay progress bar position (Off / Top / Bottom)
- Auto-link entities in transcription (wikilink existing note names & aliases)
- Personal context (optional terms to reduce transcription mistakes)
