import { App, PluginSettingTab, Setting, Notice, Plugin } from "obsidian";

export interface LonghandSettings {
  openaiApiKey: string;
  azureEndpoint: string;
  azureApiKey: string;
  convertHeicToJpeg: boolean; // best-effort; will fall back if conversion not supported
  replaceHeicEmbedsInNote: boolean; // rewrite note links to JPEG after converting
  downscaleForLLM: boolean; // OCR always uses original bytes
  imageLimit: number; // cap per run
  showStatusBarProgress: boolean;
  showStartFinishNotices: boolean;
  personalContext: string;
  autoLinkEntities: boolean; // auto-wikilink entities in transcription
  showFloatingToastProgress: boolean; // mobile-friendly transient messages
  overlayProgressPosition: "off" | "top" | "bottom"; // fixed progress bar position
}

export const DEFAULT_SETTINGS: LonghandSettings = {
  openaiApiKey: "",
  azureEndpoint: "",
  azureApiKey: "",
  convertHeicToJpeg: true,
  replaceHeicEmbedsInNote: true,
  downscaleForLLM: false,
  imageLimit: 10,
  showStatusBarProgress: true,
  showStartFinishNotices: true,
  personalContext: "",
  autoLinkEntities: false,
  showFloatingToastProgress: false,
  overlayProgressPosition: "off",
};

export class LonghandSettingTab extends PluginSettingTab {
  plugin: Plugin;
  settings: LonghandSettings;
  onSave: (s: LonghandSettings) => Promise<void>;

  constructor(app: App, plugin: Plugin, settings: LonghandSettings, onSave: (s: LonghandSettings) => Promise<void>) {
    super(app, plugin);
    this.plugin = plugin;
    this.settings = settings;
    this.onSave = onSave;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Longhand Settings" });

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Used for GPT-4o vision. Stored locally in your .obsidian plugins data.")
      .addText((t: any) =>
        t
          .setPlaceholder("sk-...")
          .setValue(this.settings.openaiApiKey)
          .onChange(async (v: string) => {
            this.settings.openaiApiKey = v.trim();
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Azure Computer Vision Endpoint")
      .setDesc("Example: https://YOUR-RESOURCE-NAME.cognitiveservices.azure.com")
      .addText((t: any) =>
        t
          .setPlaceholder("https://...cognitiveservices.azure.com")
          .setValue(this.settings.azureEndpoint)
          .onChange(async (v: string) => {
            this.settings.azureEndpoint = v.trim().replace(/\/+$/, "");
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Azure Computer Vision Key")
      .setDesc("Subscription key for Azure OCR 'read' feature.")
      .addText((t: any) =>
        t
          .setPlaceholder("Azure OCR key")
          .setValue(this.settings.azureApiKey)
          .onChange(async (v: string) => {
            this.settings.azureApiKey = v.trim();
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Convert HEIC to JPEG")
      .setDesc("Try to convert HEIC images before processing. If conversion fails, images will still be processed when possible.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.convertHeicToJpeg).onChange(async (v: boolean) => {
          this.settings.convertHeicToJpeg = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Replace HEIC embeds with JPEG in note")
      .setDesc("When enabled, converts HEIC/HEIF files to JPEG and rewrites embeds/links in the current note to reference the JPEG. Original HEIC file is kept.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.replaceHeicEmbedsInNote).onChange(async (v: boolean) => {
          this.settings.replaceHeicEmbedsInNote = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Downscale images for LLM")
      .setDesc("When enabled, only the model input is downscaled (OCR uses full resolution). Helps reduce cost while preserving readability.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.downscaleForLLM).onChange(async (v: boolean) => {
          this.settings.downscaleForLLM = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Show status bar progress")
      .setDesc("Show a temporary message in the status bar while processing.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.showStatusBarProgress).onChange(async (v: boolean) => {
          this.settings.showStatusBarProgress = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Show start/finish notices")
      .setDesc("Show a popup notice when processing starts and finishes.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.showStartFinishNotices).onChange(async (v: boolean) => {
          this.settings.showStartFinishNotices = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Show floating toast progress")
      .setDesc("Show transient progress messages as floating toasts (useful on mobile).")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.showFloatingToastProgress).onChange(async (v: boolean) => {
          this.settings.showFloatingToastProgress = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Overlay progress bar position")
      .setDesc("Show a fixed overlay progress bar (top or bottom) during processing.")
      .addDropdown((dd: any) =>
        dd
          .addOption("off", "Off")
          .addOption("top", "Top")
          .addOption("bottom", "Bottom")
          .setValue(this.settings.overlayProgressPosition)
          .onChange(async (v: string) => {
            if (v === "off" || v === "top" || v === "bottom") {
              this.settings.overlayProgressPosition = v;
              await this.onSave(this.settings);
            }
          })
      );

    new Setting(containerEl)
      .setName("Personal context for transcription")
      .setDesc("Optional names/terms (e.g., family, project jargon). Sent to the LLM to reduce mistakes (e.g., Roa vs Rod). Avoid sensitive info.")
      .addTextArea((t: any) =>
        t
          .setPlaceholder("e.g., I have two sons, X and Y. X is older. My wife is called Z.")
          .setValue(this.settings.personalContext)
          .onChange(async (v: string) => {
            const trimmed = v.trim();
            const MAX = 2000;
            if (trimmed.length > MAX) {
              new Notice("Personal context limited to 2000 characters; extra was truncated.");
              this.settings.personalContext = trimmed.slice(0, MAX);
            } else {
              this.settings.personalContext = trimmed;
            }
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Auto-link entities in transcription")
      .setDesc("Automatically wikilink first occurrence of existing note names (and their frontmatter aliases) in the new transcription.")
      .addToggle((tg: any) =>
        tg.setValue(this.settings.autoLinkEntities).onChange(async (v: boolean) => {
          this.settings.autoLinkEntities = v;
          await this.onSave(this.settings);
        })
      );

    new Setting(containerEl)
      .setName("Image limit")
      .setDesc("Maximum number of images processed per command.")
      .addText((t: any) =>
        t
          .setPlaceholder("10")
          .setValue(String(this.settings.imageLimit))
          .onChange(async (v: string) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) {
              new Notice("Image limit must be a positive number.");
              return;
            }
            this.settings.imageLimit = Math.floor(n);
            await this.onSave(this.settings);
          })
      );
  }
}
