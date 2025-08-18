import { App, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, LonghandSettingTab, LonghandSettings } from "./settings";
import { collectImagesFromNote, NoteImageRef } from "./services/noteService";
import { prepareForProcessing } from "./services/imagePrep";
import { azureOcr } from "./services/ocrService";
import { openAiTranscription } from "./services/openaiService";
import { ProgressService } from "./services/progress";
import { convertHeicVaultFileToJpeg, rewriteNoteLinks } from "./services/heicReplace";
import { wikilinkEntities } from "./services/wikilinkEntities";

export default class LonghandPlugin extends Plugin {
  settings: LonghandSettings = { ...DEFAULT_SETTINGS };

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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
    const progress = new ProgressService(this.app, this, {
      statusBar: this.settings.showStatusBarProgress,
      startFinishNotices: this.settings.showStartFinishNotices,
      floatingToast: this.settings.showFloatingToastProgress,
      overlayPosition: this.settings.overlayProgressPosition,
    });

    try {
      progress.start("Longhand: scanning images…");

      const file = this.app.workspace.getActiveFile();
      if (!file) {
        progress.fail("No active note.");
        return;
      }

      if (!this.settings.openaiApiKey) {
        progress.fail("OpenAI API key not set in settings.");
        return;
      }
      if (!this.settings.azureEndpoint || !this.settings.azureApiKey) {
        progress.fail("Azure OCR endpoint/key not set in settings.");
        return;
      }

      let images: NoteImageRef[] = [];
      try {
        images = await collectImagesFromNote(this.app, file, this.settings.imageLimit);
      } catch (e: any) {
        console.error(e);
        progress.fail("Failed to parse images from note.");
        return;
      }

      if (images.length === 0) {
        progress.fail("No images found in current note.");
        return;
      }

      if (images.length > this.settings.imageLimit) {
        images = images.slice(0, this.settings.imageLimit);
        progress.set(`Processing first ${this.settings.imageLimit} images (limit).`);
      }

      // Convert HEIC files and rewrite embeds if setting enabled
      if (this.settings.replaceHeicEmbedsInNote) {
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
      }

      progress.set(`Preparing ${images.length} image(s)…`);

      // Pre-process + OCR
      const perImageResults: {
        ref: NoteImageRef;
        fileName: string;
        llmDataUrl?: string; // downscaled (optional)
        ocrText: string;
      }[] = [];

      for (let i = 0; i < images.length; i++) {
        const ref = images[i];
        try {
          progress.setProgress(i, images.length, `Preparing image ${i + 1}/${images.length}: ${ref.file.name}`);
          const prep = await prepareForProcessing(
            this.app,
            ref.file,
            this.settings.convertHeicToJpeg,
            this.settings.downscaleForLLM
          );

          let ocrText = "";
          try {
            ocrText = await azureOcr(prep.ocrBytes, this.settings.azureEndpoint, this.settings.azureApiKey);
            progress.set(`OCR ${i + 1}/${images.length} complete`);
          } catch (ocrErr) {
            console.warn(`Azure OCR failed for ${ref.file.name}:`, ocrErr);
            ocrText = "";
            progress.set(`OCR ${i + 1}/${images.length} failed; continuing`);
          }

          perImageResults.push({
            ref,
            fileName: ref.file.name,
            llmDataUrl: prep.llmDataUrl,
            ocrText,
          });
        } catch (e: any) {
          console.error(`Failed to prepare image ${ref.file.name}`, e);
        }
      }

      // Ensure we have at least one image prepared for LLM
      const anyLlmImages = perImageResults.some((r) => !!r.llmDataUrl);
      if (!anyLlmImages) {
        progress.fail("Failed to prepare images for model input.");
        return;
      }

      const usableCount = perImageResults.filter((r) => !!r.llmDataUrl).length;
      progress.set(`Calling OpenAI with ${usableCount} image(s)…`);

      // Single OpenAI call with all images + OCR bundle
      let modelOutput = "";
      try {
        modelOutput = await openAiTranscription(
          this.settings.openaiApiKey,
          perImageResults.map((r) => ({
            fileName: r.fileName,
            alt: r.ref.alt || "",
            ocrText: r.ocrText,
            dataUrl: r.llmDataUrl, // can be undefined for some; service will filter
          })),
          this.settings.personalContext
        );
      } catch (e: any) {
        console.error(e);
        progress.fail("OpenAI request failed.");
        return;
      }

      progress.set("OpenAI response received.");

      if (!modelOutput || modelOutput.trim().length === 0) {
        progress.fail("Model returned empty result.");
        return;
      }

      if (this.settings.autoLinkEntities) {
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
        const original = await this.app.vault.read(file);
        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const heading = `## Longhand transcription (${timestamp})`;
        const newContent = `${heading}\n\n${modelOutput.trim()}\n\n---\n\n${original}`;
        await this.app.vault.modify(file, newContent);
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
