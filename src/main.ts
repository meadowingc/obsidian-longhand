import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, LonghandSettingTab, LonghandSettings } from "./settings";
import { collectImagesFromNote, NoteImageRef } from "./services/noteService";
import { prepareForProcessing } from "./services/imagePrep";
import { formatModelError, LlmInputItem, openAiTranscription, validateBaseUrl } from "./services/openaiService";
import { ProgressService } from "./services/progress";
import { convertHeicVaultFileToJpeg, rewriteNoteLinks } from "./services/heicReplace";
import { wikilinkEntities } from "./services/wikilinkEntities";
import { type RetryOptions, withRetry } from "./services/retry";
import { cleanInvisibleCharacters } from "./services/textCleanup";

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

    this.addCommand({
      id: "longhand-clean-invisible-characters-in-current-note",
      name: "Clean invisible characters in current note",
      callback: () => this.cleanInvisibleCharactersInCurrentNote(),
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

  private async cleanInvisibleCharactersInCurrentNote() {
    await this.runWithProcessingGuard(async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice("No active note.");
        return;
      }
      if (file.extension.toLowerCase() !== "md") {
        new Notice("Invisible-character cleanup requires a Markdown note.");
        return;
      }

      let removedCount = 0;
      let retried = false;
      const retry: RetryOptions = {
        maxRetries: this.settings.retryTransientErrors ? 2 : 0,
        onRetry: ({ attempt, maxAttempts, delayMs }) => {
          retried = true;
          new Notice(`Note cleanup: temporary failure; retry ${attempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s...`);
        },
      };
      try {
        const source = await withRetry(() => this.app.vault.read(file), retry);
        if (!cleanInvisibleCharacters(source).removedCount) {
          new Notice("Longhand: no removable invisible characters found in note prose.");
          return;
        }
        await withRetry(() => this.app.vault.process(file, (current) => {
          const result = cleanInvisibleCharacters(current);
          removedCount = result.removedCount;
          return result.text;
        }), retry);
        new Notice(retried
          ? "Longhand: invisible-character cleanup complete."
          : `Longhand: removed ${removedCount} invisible character(s) from note prose.`);
      } catch (error) {
        console.error("Longhand: invisible-character cleanup failed", error);
        new Notice(`Failed to clean invisible characters: ${formatModelError(error)}`, 15000);
      }
    });
  }

  private async convertHeicToJpegInCurrentNote() {
    await this.runWithProcessingGuard(() => this.convertHeicImagesInCurrentNote());
  }

  private async convertHeicImagesInCurrentNote() {
    const settings = { ...this.settings };
    const progress = new ProgressService(this.app, this, {
      statusBar: this.settings.showStatusBarProgress,
      startFinishNotices: this.settings.showStartFinishNotices,
      floatingToast: this.settings.showFloatingToastProgress,
      overlayPosition: this.settings.overlayProgressPosition,
    });

    progress.start("Longhand: scanning images…");

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      progress.fail("No active note.");
      return;
    }
    const retry = this.retryOptions(settings, progress);

    let images: NoteImageRef[] = [];
    try {
      images = await withRetry(() => collectImagesFromNote(this.app, file, settings.imageLimit), retry("Reading note"));
    } catch (e: any) {
      console.error(e);
      progress.fail(`Failed to read images from note. ${formatModelError(e)}`);
      return;
    }

    const replacements = new Map<string, string>();
    let failedConversions = 0;
    for (const r of images) {
      if (/\.hei[cf]$/i.test(r.file.name)) {
        try {
          const jpg = await convertHeicVaultFileToJpeg(this.app, r.file, retry(`Converting ${r.file.name}`));
          replacements.set(r.file.path, jpg.path);
        } catch (e) {
          failedConversions++;
          console.warn(`HEIC->JPEG conversion failed for ${r.file.path}`, e);
          new Notice(`HEIC conversion failed for ${r.file.name}: ${formatModelError(e)}`, 10000);
        }
      }
    }
    if (replacements.size) {
      try {
        progress.set("Rewriting HEIC embeds to JPEG…");
        await rewriteNoteLinks(this.app, file, replacements, retry("Rewriting HEIC embeds"));
        // Refresh image list to reflect new JPEG links
        images = await withRetry(() => collectImagesFromNote(this.app, file, settings.imageLimit), retry("Reading note"));
        if (images.length > settings.imageLimit) {
          images = images.slice(0, settings.imageLimit);
          progress.set(`Processing first ${settings.imageLimit} images (limit).`);
        }
      } catch (e) {
        console.warn("Failed to rewrite note links for HEIC->JPEG.", e);
        progress.fail(`Failed to replace HEIC embeds: ${formatModelError(e)}`);
        return;
      }
    }

    if (failedConversions) {
      progress.fail(`Longhand: ${failedConversions} HEIC conversion(s) failed. Successfully converted images were kept.`);
    } else {
      progress.done("Longhand: image processing complete.");
    }
  }

  private async processImagesInCurrentNote() {
    await this.runWithProcessingGuard(() => this.transcribeCurrentNote());
  }

  private async runWithProcessingGuard(operation: () => Promise<void>) {
    if (this.processing) {
      new Notice("Longhand is already processing images. Please wait.");
      return;
    }
    this.processing = true;
    try {
      await operation();
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
    const retry = this.retryOptions(settings, progress);

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
        images = await withRetry(() => collectImagesFromNote(this.app, file, settings.imageLimit), retry("Reading note"));
      } catch (e: any) {
        console.error(e);
        progress.fail(`Failed to read images from note. ${formatModelError(e)}`);
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
              const jpg = await convertHeicVaultFileToJpeg(this.app, r.file, retry(`Converting ${r.file.name}`));
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
            await rewriteNoteLinks(this.app, file, replacements, retry("Rewriting HEIC embeds"));
            // Refresh image list to reflect new JPEG links
            images = await withRetry(() => collectImagesFromNote(this.app, file, settings.imageLimit), retry("Reading note"));
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
            settings.downscaleForLLM,
            retry(`Reading ${ref.file.name}`)
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
          settings.personalContext,
          retry("Model request").onRetry
        );
      } catch (e: any) {
        console.error(e);
        progress.fail(formatModelError(e));
        return;
      }

      progress.set("Model response received.");

      if (settings.cleanInvisibleCharacters) {
        try {
          const result = cleanInvisibleCharacters(modelOutput);
          modelOutput = result.text;
          if (!modelOutput.trim()) {
            progress.fail("The model returned no readable transcription after invisible-character cleanup.");
            return;
          }
          if (result.removedCount) {
            progress.set(`Cleaned ${result.removedCount} invisible character(s) from transcription prose.`);
          }
        } catch (error) {
          console.error("Longhand: transcription cleanup failed", error);
          progress.fail(`Failed to clean transcription: ${formatModelError(error)}`);
          return;
        }
      }

      if (settings.autoLinkEntities) {
        try {
          progress.set("Auto-linking entities…");
          modelOutput = await withRetry(() => wikilinkEntities(this.app, file, modelOutput), retry("Auto-linking entities"));
        } catch (e) {
          console.warn("Auto-link entities failed", e);
          new Notice(`Failed to auto-link entities: ${formatModelError(e)}`, 10000);
        }
      }

      progress.set("Writing transcription to note…");

      // Prepend to note with heading + timestamp
      try {
        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const heading = `## Longhand transcription (${timestamp})`;
        const insertion = `${heading}\n\n${modelOutput.trim()}\n\n---\n\n`;
        let beforeWrite: string | undefined;
        await withRetry(() => this.app.vault.process(file, (original) => {
          if (beforeWrite !== undefined) {
            if (original.split(insertion).length > beforeWrite.split(insertion).length) return original;
            if (original !== beforeWrite) {
              throw new Error("The note changed after a failed write. Check whether the transcription was inserted before running the command again.");
            }
          }
          beforeWrite = original;
          return `${insertion}${original}`;
        }), retry("Writing transcription"));
        progress.done(`Longhand: inserted transcription for ${perImageResults.length} image(s).`);
      } catch (e: any) {
        console.error(e);
        progress.fail(`Failed to insert transcription into note. ${formatModelError(e)}`);
      }
    } finally {
      // ensure cleanup if not already disposed
      progress.dispose();
    }
  }

  private retryOptions(settings: LonghandSettings, progress: ProgressService): (label: string) => RetryOptions {
    return (label) => ({
      maxRetries: settings.retryTransientErrors ? 2 : 0,
      onRetry: ({ attempt, maxAttempts, delayMs }) => {
        progress.set(`${label}: temporary failure; retry ${attempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s...`);
      },
    });
  }
}

// Re-export types for services
export type { LonghandSettings } from "./settings";
