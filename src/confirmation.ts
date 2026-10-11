import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, SelectList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { requireThat } from "./values.js";

/** One confirmation owns its viewport, selection, and abort listener. */
export class ConfirmationDialog implements Component {
  private readonly details: Text;
  private readonly scroll: ScrollView;
  private readonly choices: SelectList;
  private finished = false;
  private usable = false;
  private showingRaw = false;
  private readonly abort = () => this.finish(false);

  constructor(
    private readonly title: string,
    private readonly text: string,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly rows: () => number,
    private readonly requestRender: () => void,
    private readonly done: (allowed: boolean) => void,
    private readonly signal?: AbortSignal,
    private readonly summary?: string,
  ) {
    this.details = new Text(summary ?? text, 0, 0);
    this.scroll = new ScrollView(this.details, { overscroll: "contain" });
    this.choices = new SelectList([{ value: "cancel", label: "取消" }, { value: "allow", label: "确认" }], 2, {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("accent", text),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("dim", text),
      noMatch: text => theme.fg("dim", text),
    });
    this.choices.onSelect = item => this.finish(item.value === "allow");
    this.choices.onCancel = () => this.finish(false);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.finish(false);
  }

  private finish(allowed: boolean) {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(allowed && this.usable && !this.signal?.aborted);
  }

  dispose() { this.signal?.removeEventListener("abort", this.abort); }

  invalidate() {
    this.details.invalidate();
    this.choices.invalidate();
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.rows()));
    this.usable = width >= 24 && height >= 8;
    if (!this.usable) {
      return new Text("窗口过小；请放大终端。Esc 取消。", 0, 0).render(Math.max(1, width)).slice(0, height);
    }
    const content = this.scroll.render(width);
    const viewport = height - (this.summary === undefined ? 6 : 7);
    this.scroll.updateLayout(content.length, viewport, this.requestRender);
    const start = this.scroll.scrollTop;
    const visible = content.slice(start, start + viewport);
    while (visible.length < viewport) visible.push("");
    return [
      this.theme.fg("accent", truncateToWidth(this.title, width)),
      ...visible,
      this.theme.fg("dim", truncateToWidth(`${start + 1}–${Math.min(start + viewport, content.length)} / ${content.length}`, width)),
      ...this.choices.render(width),
      this.theme.fg("dim", truncateToWidth("↑↓滚动 PgUp/PgDn翻页", width)),
      this.theme.fg("dim", truncateToWidth("Tab切换 Enter选 Esc取消", width)),
      ...(this.summary === undefined ? [] : [this.theme.fg("dim", this.showingRaw ? "D 查看摘要" : "D 查看完整配置")]),
    ];
  }

  handleInput(data: string) {
    if (this.finished) return;
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
      this.finish(false); return;
    }
    if (!this.usable) return;
    if (matchesKey(data, "d") && this.summary !== undefined) {
      this.showingRaw = !this.showingRaw;
      this.details.setText(this.showingRaw ? this.text : this.summary);
      this.scroll.scrollToStart();
      this.choices.setSelectedIndex(0);
    } else if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.choices.setSelectedIndex(this.choices.getSelectedItem()?.value === "cancel" ? 1 : 0);
    } else if (this.keys.matches(data, "tui.select.confirm")) this.finish(this.choices.getSelectedItem()?.value === "allow");
    this.requestRender();
  }
}

export async function ask(ctx: ExtensionContext, title: string, value: unknown, signal?: AbortSignal, summary?: string): Promise<boolean> {
  requireThat(ctx.hasUI, "此操作需要用户确认通道，非交互模式不能授权。");
  signal?.throwIfAborted();
  const text = JSON.stringify(value, null, 2);
  // RPC clients own their layout. Keep the complete payload separate from the title.
  const allowed = ctx.mode === "tui"
    ? await ctx.ui.custom<boolean>((tui, theme, keys, done) => new ConfirmationDialog(
      title, text, theme, keys, () => tui.terminal.rows, () => tui.requestRender(), done, signal, summary,
    ), { overlay: true, overlayOptions: { width: 100, anchor: "center" } })
    : await ctx.ui.confirm(title, summary === undefined ? text : `${summary}\n\n完整配置：\n${text}`, signal ? { signal } : {});
  signal?.throwIfAborted();
  return allowed === true;
}
