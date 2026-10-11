import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, LonghandSettingTab, LonghandSettings } from "./settings";
import { collectImagesFromNote, NoteImageRef } from "./services/noteService";
import { prepareForProcessing } from "./services/imagePrep";
import { formatModelError, LlmInputItem, openAiTranscription, validateBaseUrl } from "./services/openaiService";
import { ProgressService } from "./services/progress";
import { convertHeicVaultFileToJpeg, rewriteNoteLinks } from "./services/heicReplace";
import { wikilinkEntities } from "./services/wikilinkEntities";

export default class LonghandPlugin extends Plugin {
  settings: LonghandSettings = { ...DEFAULT_SETTINGS };
  private processing = false;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(
      new LonghandSettingTab(this.app, this, this.settings, async (s: LonghandSettings) => {
        this.settings = { ...s };
        await this.saveSettings();
      })
    );

    this.addCommand({
      id: "longhand-process-images-in-current-note",
      name: "Process images in current note",
      callback: () => this.processImagesInCurrentNote(),
    });

    this.addCommand({
      id: "longhand-convert-heic-to-jpeg",
      name: "Convert HEIC to JPEG in current note",
      callback: () => this.convertHeicToJpegInCurrentNote(),
    });
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS };
    // Retain current settings and discard obsolete Azure OCR credentials.
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LonghandSettings)[]) {
      if (data && typeof data[key] === typeof DEFAULT_SETTINGS[key]) {
        Object.assign(this.settings, { [key]: data[key] });
      }
    }
    await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async convertHeicToJpegInCurrentNote() {
    const progress = new ProgressService(this.app, this, {
      statusBar: this.settings.showStatusBarProgress,
      startFinishNotices: this.settings.showStartFinishNotices,
      floatingToast: this.settings.showFloatingToastProgress,
      overlayPosition: this.settings.overlayProgressPosition,
    });

    progress.start("Longhand: scanning images…");

    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    let images: NoteImageRef[] = [];
    try {
      images = await collectImagesFromNote(this.app, file, this.settings.imageLimit);
    } catch (e: any) {
      console.error(e);
      progress.fail("Failed to parse images from note.");
      return;
    }

    const replacements = new Map<string, string>();
    for (const r of images) {
      if (/\.hei[cf]$/i.test(r.file.name)) {
        try {
          const jpg = await convertHeicVaultFileToJpeg(this.app, r.file);
          replacements.set(r.file.path, jpg.path);
        } catch (e) {
          console.warn(`HEIC->JPEG conversion failed for ${r.file.path}`, e);
        }
      }
    }
    if (replacements.size) {
      try {
        progress.set("Rewriting HEIC embeds to JPEG…");
        await rewriteNoteLinks(this.app, file, replacements);
        // Refresh image list to reflect new JPEG links
        images = await collectImagesFromNote(this.app, file, this.settings.imageLimit);
        if (images.length > this.settings.imageLimit) {
          images = images.slice(0, this.settings.imageLimit);
          progress.set(`Processing first ${this.settings.imageLimit} images (limit).`);
        }
      } catch (e) {
        console.warn("Failed to rewrite note links for HEIC->JPEG.", e);
      }
    }

    progress.done("Longhand: image processing complete.");
  }

  private async processImagesInCurrentNote() {
    if (this.processing) {
      new Notice("Longhand is already processing images. Please wait.");
      return;
    }
    this.processing = true;
    try {
      await this.transcribeCurrentNote();
    } finally {
      this.processing = false;
    }
  }

  private async transcribeCurrentNote() {
    const settings = { ...this.settings };
    const progress = new ProgressService(this.app, this, {
      statusBar: settings.showStatusBarProgress,
      startFinishNotices: settings.showStartFinishNotices,
      floatingToast: settings.showFloatingToastProgress,
      overlayPosition: settings.overlayProgressPosition,
    });

    try {
      progress.start("Longhand: scanning images…");

      const file = this.app.workspace.getActiveFile();
      if (!file) {
        progress.fail("No active note.");
        return;
      }

      if (!settings.openaiApiKey.trim()) {
        progress.fail("Provider API key not set in Longhand settings.");
        return;
      }
      try {
        validateBaseUrl(settings.openaiBaseUrl);
        if (!settings.openaiModel.trim()) throw new Error("Set a vision-capable model ID in Longhand settings.");
      } catch (error) {
        progress.fail(formatModelError(error));
        return;
      }
      if (!Number.isInteger(settings.imageLimit) || settings.imageLimit < 1) {
        progress.fail("Image limit must be a positive integer in Longhand settings.");
        return;
      }

      let images: NoteImageRef[] = [];
      try {
        images = await collectImagesFromNote(this.app, file, settings.imageLimit);
      } catch (e: any) {
        console.error(e);
        progress.fail("Failed to parse images from note.");
        return;
      }

      if (images.length === 0) {
        progress.fail("No images found in current note.");
        return;
      }

      if (images.length > settings.imageLimit) {
        images = images.slice(0, settings.imageLimit);
        progress.set(`Processing first ${settings.imageLimit} images (limit).`);
      }

      // Convert HEIC files and rewrite embeds if setting enabled
      if (settings.replaceHeicEmbedsInNote) {
        const replacements = new Map<string, string>();
        for (const r of images) {
          if (/\.hei[cf]$/i.test(r.file.name)) {
            try {
              const jpg = await convertHeicVaultFileToJpeg(this.app, r.file);
              replacements.set(r.file.path, jpg.path);
            } catch (e) {
              console.warn(`HEIC->JPEG conversion failed for ${r.file.path}`, e);
              new Notice(`HEIC conversion failed for ${r.file.name}: ${formatModelError(e)}`, 10000);
            }
          }
        }
        if (replacements.size) {
          try {
            progress.set("Rewriting HEIC embeds to JPEG…");
            await rewriteNoteLinks(this.app, file, replacements);
            // Refresh image list to reflect new JPEG links
            images = await collectImagesFromNote(this.app, file, settings.imageLimit);
            if (images.length > settings.imageLimit) {
              images = images.slice(0, settings.imageLimit);
              progress.set(`Processing first ${settings.imageLimit} images (limit).`);
            }
          } catch (e) {
            console.warn("Failed to rewrite note links for HEIC->JPEG.", e);
            new Notice(`Failed to replace HEIC embeds: ${formatModelError(e)}`, 10000);
          }
        }
      }

      progress.set(`Preparing ${images.length} image(s)…`);

      const perImageResults: LlmInputItem[] = [];

      for (let i = 0; i < images.length; i++) {
        const ref = images[i];
        try {
          progress.setProgress(i, images.length, `Preparing image ${i + 1}/${images.length}: ${ref.file.name}`);
          const prep = await prepareForProcessing(
            this.app,
            ref.file,
            settings.convertHeicToJpeg,
            settings.downscaleForLLM
          );

          perImageResults.push({
            fileName: ref.file.name,
            alt: ref.alt || "",
            dataUrl: prep.llmDataUrl,
          });
        } catch (e: any) {
          console.error(`Failed to prepare image ${ref.file.name}`, e);
          new Notice(`Skipped ${ref.file.name}: ${formatModelError(e)}`, 10000);
        }
      }

      if (perImageResults.length === 0) {
        progress.fail("Failed to prepare images for model input.");
        return;
      }

      progress.set(`Calling ${settings.openaiModel} with ${perImageResults.length} image(s)…`);

      let modelOutput = "";
      try {
        modelOutput = await openAiTranscription(
          settings,
          perImageResults,
          settings.personalContext
        );
      } catch (e: any) {
        console.error(e);
        progress.fail(formatModelError(e));
        return;
      }

      progress.set("Model response received.");

      if (settings.autoLinkEntities) {
        try {
          progress.set("Auto-linking entities…");
          modelOutput = await wikilinkEntities(this.app, file, modelOutput);
        } catch (e) {
          console.warn("Auto-link entities failed", e);
        }
      }

      progress.set("Writing transcription to note…");

      // Prepend to note with heading + timestamp
      try {
        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const heading = `## Longhand transcription (${timestamp})`;
        await this.app.vault.process(file, (original) => `${heading}\n\n${modelOutput.trim()}\n\n---\n\n${original}`);
        progress.done(`Longhand: inserted transcription for ${perImageResults.length} image(s).`);
      } catch (e: any) {
        console.error(e);
        progress.fail("Failed to insert transcription into note.");
      }
    } finally {
      // ensure cleanup if not already disposed
      progress.dispose();
    }
  }
}

// Re-export types for services
export type { LonghandSettings } from "./settings";
