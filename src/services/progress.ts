import { App, Notice, Plugin } from "obsidian";

export interface ProgressOptions {
  statusBar: boolean;
  startFinishNotices: boolean;
}

export class ProgressService {
  private el?: HTMLElement;
  private disposed = false;
  private last = "";

  constructor(private app: App, private plugin: Plugin, private opts: ProgressOptions) {
    if (opts.statusBar) {
      this.el = this.plugin.addStatusBarItem();
    }
  }

  start(msg: string) {
    if (this.opts.startFinishNotices) new Notice(msg);
    this.set(msg);
  }

  set(msg: string) {
    if (this.disposed || msg === this.last) return;
    this.last = msg;
    if (this.el) this.el.textContent = msg;
  }

  done(msg: string) {
    if (this.opts.startFinishNotices) new Notice(msg);
    this.set(msg);
    this.dispose();
  }

  fail(msg: string) {
    new Notice(msg);
    this.set(msg);
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.el?.remove();
    this.disposed = true;
  }
}
