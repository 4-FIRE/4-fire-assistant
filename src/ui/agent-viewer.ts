import { Text, ScrollView, truncateToWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

/** All asynchronous reads happen outside render. Each interaction owns its subscriptions. */
export class AgentViewer implements Component {
  private readonly text = new Text("", 0, 0);
  private readonly scroll = new ScrollView(this.text, { overscroll: "contain" });
  private readonly unsubscribe: () => void;
  private readonly abort = () => this.finish();
  private version = 0;
  private finished = false;
  private disposed = false;
  private following = true;
  constructor(private readonly title: string, private readonly read: () => Promise<string>,
    subscribe: (refresh: () => void) => () => void, private readonly rows: () => number,
    private readonly requestRender: () => void, private readonly done: () => void,
    private readonly keys: KeybindingsManager, private readonly theme: Theme, private readonly signal: AbortSignal) {
    this.unsubscribe = subscribe(() => { void this.refresh(); });
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.finish(); else void this.refresh();
  }
  private async refresh() {
    if (this.finished) return;
    const version = ++this.version;
    try {
      const text = await this.read();
      if (this.finished || version !== this.version) return;
      this.text.setText(text); this.requestRender();
    } catch (error) {
      if (this.finished || version !== this.version) return;
      this.text.setText(String(error)); this.requestRender();
    }
  }
  finish() { if (this.finished) return; this.finished = true; this.dispose(); this.done(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.finished = true; this.version++;
    this.unsubscribe(); this.signal.removeEventListener("abort", this.abort);
  }
  invalidate() { this.text.invalidate(); }
  render(width: number) {
    width = Math.max(1, width);
    const height = Math.max(1, Math.floor(this.rows() * 0.8)), content = this.scroll.render(width);
    const viewport = Math.max(1, height - 3);
    this.scroll.updateLayout(content.length, viewport, this.requestRender);
    if (this.following) this.scroll.scrollToEnd();
    return [this.theme.fg("borderMuted", "╭─ ") + this.theme.style(this.title, { fg: "accent", bold: true }),
      ...content.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport),
      this.theme.fg("borderMuted", "╰─ ") + this.theme.fg(this.following ? "accent" : "dim",
        this.following ? "● 实时跟随 · ↑↓ PgUp/PgDn 浏览 · Esc 返回" : "○ 浏览 · End 恢复跟随 · Home 顶部 · Esc 返回"),
    ].slice(0, height).map(line => truncateToWidth(line, width));
  }
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) { this.finish(); return; }
    if (matchesKey(data, "end")) this.following = true;
    else {
      this.following = false;
      if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
      else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
      else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
      else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
      else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    }
    this.requestRender();
  }
}
