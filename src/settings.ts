import { App, PluginSettingTab, Setting, Notice, Plugin } from "obsidian";

export interface LonghandSettings {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  convertHeicToJpeg: boolean;
  replaceHeicEmbedsInNote: boolean; // rewrite note links to JPEG after converting
  downscaleForLLM: boolean;
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
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-4o",
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
      .setName("Provider API key")
      .setDesc("Use a key from the provider below. Stored locally, unencrypted, in your plugin data. OpenAI API billing is separate from ChatGPT subscriptions.")
      .addText((t) => {
        t.inputEl.type = "password";
        t
          .setPlaceholder("sk-...")
          .setValue(this.settings.openaiApiKey)
          .onChange(async (v: string) => {
            this.settings.openaiApiKey = v.trim();
            await this.onSave(this.settings);
          });
      });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI: https://api.openai.com/v1. OpenRouter: https://openrouter.ai/api/v1. Use the API base, not the full /chat/completions URL. Images and personal context are sent to this provider.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.openaiBaseUrl)
          .setValue(this.settings.openaiBaseUrl)
          .onChange(async (v: string) => {
            this.settings.openaiBaseUrl = v.trim().replace(/\/+$/, "");
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Vision model")
      .setDesc("Exact image-capable model ID from your provider. OpenRouter IDs include a prefix, for example openai/gpt-4o.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.openaiModel)
          .setValue(this.settings.openaiModel)
          .onChange(async (v: string) => {
            this.settings.openaiModel = v.trim();
            await this.onSave(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Convert HEIC to JPEG")
      .setDesc("Convert HEIC/HEIF to JPEG for model input. Unsupported or failed conversions are reported rather than sent to the provider.")
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
      .setDesc("Resize model input to a maximum edge of 2048 pixels. Reduces upload size and cost, but may reduce handwriting detail.")
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
            if (!Number.isInteger(n) || n < 1) {
              new Notice("Image limit must be a positive integer.");
              return;
            }
            this.settings.imageLimit = n;
            await this.onSave(this.settings);
          })
      );
  }
}
