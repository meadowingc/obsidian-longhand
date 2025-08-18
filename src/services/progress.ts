import { App, Notice, Plugin } from "obsidian";

export interface ProgressOptions {
  statusBar: boolean;
  startFinishNotices: boolean;
  floatingToast: boolean;
  overlayPosition: "off" | "top" | "bottom";
}

/**
 * Lightweight log entry (future expansion).
 */
interface ProgressLogEntry {
  time: number;
  message: string;
  current?: number;
  total?: number;
  kind: "info" | "error" | "done";
}

/**
 * ProgressService
 * Provides:
 *  - Status bar text (existing behavior)
 *  - Optional floating toast updates (mobile-friendly)
 *  - Optional overlay progress bar (top/bottom)
 * API:
 *  - start(msg)
 *  - set(msg)
 *  - setProgress(current,total,msg)
 *  - done(msg)
 *  - fail(msg)
 *  - dispose()
 */
export class ProgressService {
  private statusEl?: HTMLElement;
  private toastContainer?: HTMLElement;
  private overlayEl?: HTMLElement;
  private overlayBarEl?: HTMLElement;
  private overlayTextEl?: HTMLElement;
  private disposed = false;
  private last = "";
  private log: ProgressLogEntry[] = [];
  private startedAt = Date.now();
  private current?: number;
  private total?: number;

  constructor(
    private app: App,
    private plugin: Plugin,
    private opts: ProgressOptions
  ) {
    if (opts.statusBar) {
      this.statusEl = this.plugin.addStatusBarItem();
    }
    this.injectBaseCss();
    if (opts.floatingToast) {
      this.getOrCreateToastContainer();
    }
    if (opts.overlayPosition !== "off") {
      this.createOverlay(opts.overlayPosition);
    }
  }

  start(msg: string) {
    if (this.opts.startFinishNotices) new Notice(msg);
    this.startedAt = Date.now();
    this.internalUpdate(msg, { kind: "info" });
  }

  set(msg: string) {
    if (this.disposed || msg === this.last) return;
    this.internalUpdate(msg, { kind: "info" });
  }

  setProgress(current: number, total: number, msg: string) {
    if (this.disposed) return;
    this.current = current;
    this.total = total;
    this.internalUpdate(msg, { kind: "info", current, total });
  }

  done(msg: string) {
    if (this.opts.startFinishNotices) {
      const duration = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      new Notice(`${msg} (${duration}s)`);
    }
    this.internalUpdate(msg, { kind: "done" });
    this.dispose();
  }

  fail(msg: string) {
    new Notice(msg);
    this.internalUpdate(msg, { kind: "error" });
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.statusEl?.remove();
    if (this.overlayEl) {
      this.overlayEl.classList.add("longhand-progress-fade");
      window.setTimeout(() => this.overlayEl?.remove(), 450);
    }
    window.setTimeout(() => {
      this.toastContainer?.remove();
    }, 2000);
    this.disposed = true;
  }

  // ---------- Internals ----------

  private internalUpdate(
    msg: string,
    meta: { kind: ProgressLogEntry["kind"]; current?: number; total?: number }
  ) {
    this.last = msg;
    this.log.push({
      time: Date.now(),
      message: msg,
      current: meta.current,
      total: meta.total,
      kind: meta.kind,
    });

    if (this.statusEl) this.statusEl.textContent = msg;
    if (this.opts.floatingToast) this.showToast(msg, meta.kind);
    if (this.opts.overlayPosition !== "off") this.updateOverlay(msg, meta);
  }

  private getOrCreateToastContainer(): HTMLElement {
    if (this.toastContainer && document.body.contains(this.toastContainer)) {
      return this.toastContainer;
    }
    const el = document.createElement("div");
    el.className = "longhand-toast-container";
    document.body.appendChild(el);
    this.toastContainer = el;
    return el;
  }

  private showToast(message: string, kind: ProgressLogEntry["kind"]) {
    const container = this.getOrCreateToastContainer();
    const item = document.createElement("div");
    item.className = `longhand-toast longhand-kind-${kind}`;
    item.textContent = message;
    container.appendChild(item);

    while (container.children.length > 4) {
      container.removeChild(container.firstChild!);
    }

    window.setTimeout(() => {
      item.classList.add("fade-out");
      window.setTimeout(() => item.remove(), 400);
    }, 4000);
  }

  private createOverlay(position: "top" | "bottom") {
    this.overlayEl = document.createElement("div");
    this.overlayEl.className = `longhand-overlay longhand-overlay-${position}`;
    this.overlayBarEl = document.createElement("div");
    this.overlayBarEl.className = "longhand-overlay-bar";
    const barFill = document.createElement("div");
    barFill.className = "longhand-overlay-bar-fill";
    this.overlayBarEl.appendChild(barFill);

    this.overlayTextEl = document.createElement("div");
    this.overlayTextEl.className = "longhand-overlay-text";

    this.overlayEl.appendChild(this.overlayBarEl);
    this.overlayEl.appendChild(this.overlayTextEl);
    document.body.appendChild(this.overlayEl);
  }

  private updateOverlay(
    msg: string,
    meta: { current?: number; total?: number; kind: ProgressLogEntry["kind"] }
  ) {
    if (!this.overlayEl || !this.overlayBarEl || !this.overlayTextEl) return;
    this.overlayTextEl.textContent = msg;

    const fill = this.overlayBarEl.querySelector(
      ".longhand-overlay-bar-fill"
    ) as HTMLElement | null;

    if (fill) {
      if (
        typeof meta.current === "number" &&
        typeof meta.total === "number" &&
        meta.total > 0
      ) {
        const pct = Math.min(
          100,
          Math.max(0, (meta.current / meta.total) * 100)
        );
        fill.style.width = pct.toFixed(2) + "%";
        fill.style.transition = "width 0.25s ease";
        this.overlayBarEl.classList.remove("indeterminate");
      } else {
        fill.style.width = "30%";
        this.overlayBarEl.classList.add("indeterminate");
      }

      if (meta.kind === "done") {
        fill.style.width = "100%";
        this.overlayEl.classList.add("longhand-progress-success");
      } else if (meta.kind === "error") {
        this.overlayEl.classList.add("longhand-progress-error");
      }
    }
  }

  private injectBaseCss() {
    if (document.getElementById("longhand-progress-styles")) return;
    const style = document.createElement("style");
    style.id = "longhand-progress-styles";
    style.textContent = `
.longhand-toast-container {
  position: fixed;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 80%;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.longhand-toast {
  background: var(--background-secondary, #2a2a2a);
  color: var(--text-normal, #fff);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  opacity: 0;
  animation: longhand-fade-in 160ms ease forwards;
  pointer-events: auto;
  line-height: 1.3;
  border: 1px solid var(--background-modifier-border, #444);
}
.longhand-toast.longhand-kind-error { border-color: #c0392b; }
.longhand-toast.longhand-kind-done { border-color: #27ae60; }
.longhand-toast.fade-out { opacity: 0 !important; transition: opacity 350ms ease; }

@keyframes longhand-fade-in {
  from { opacity: 0; transform: translate(-50%,6px); }
  to { opacity: 1; transform: translate(-50%,0); }
}

.longhand-overlay {
  position: fixed;
  left: 0;
  width: 100%;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 10px 6px;
  backdrop-filter: blur(6px);
  background: rgba(30,30,30,0.65);
  box-shadow: 0 2px 4px rgba(0,0,0,0.35);
  animation: longhand-slide 200ms ease;
  font-size: 12px;
  pointer-events: none;
}
.longhand-overlay-top { top: 0; border-bottom: 1px solid var(--background-modifier-border, #444); }
.longhand-overlay-bottom { bottom: 0; border-top: 1px solid var(--background-modifier-border, #444); }

@keyframes longhand-slide {
  from { transform: translateY(var(--y, -100%)); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.longhand-overlay-bottom { --y: 100%; }

.longhand-overlay-bar {
  position: relative;
  height: 5px;
  width: 100%;
  background: rgba(255,255,255,0.15);
  border-radius: 3px;
  overflow: hidden;
}
.longhand-overlay-bar-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  background: linear-gradient(90deg,#4e9efc,#7ab7ff);
}
.longhand-overlay-bar.indeterminate .longhand-overlay-bar-fill {
  animation: longhand-indeterminate 1.4s infinite;
  width: 30%;
}
@keyframes longhand-indeterminate {
  0% { left: -30%; }
  50% { left: 50%; }
  100% { left: 100%; }
}
.longhand-overlay-text {
  color: var(--text-normal, #fff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.longhand-progress-success .longhand-overlay-bar-fill {
  background: linear-gradient(90deg,#2ecc71,#58d68d);
}
.longhand-progress-error .longhand-overlay-bar-fill {
  background: linear-gradient(90deg,#e74c3c,#ff6f5e);
}
.longhand-progress-fade {
  opacity: 0 !important;
  transition: opacity 400ms ease;
}
`;
    document.head.appendChild(style);
  }
}
