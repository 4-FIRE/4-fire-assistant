import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ConfirmationDialog } from "../../dist/ui/confirmation.js";

const theme = loadThemeFromPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url).pathname);
const keys = new KeybindingsManager();
const plain = lines => lines.map(line => stripTerminalSequences(line).trimEnd());
const body = lines => lines.map(line => stripTerminalSequences(line).slice(2, -2).trimEnd());
function dialog(text, signal) {
  let rows = 24;
  const decisions = [];
  const component = new ConfirmationDialog("接入权限", text, theme, keys, () => rows, () => {}, value => decisions.push(value), signal);
  return { component, decisions, resize: height => { rows = height; } };
}

test("large confirmation keeps actions fixed and every wrapped detail line reachable", () => {
  const provider = { operations: Array.from({ length: 200 }, (_, index) => ({ name: `operation_${index}`, description: "行情中文🙂", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } })) };
  const text = JSON.stringify(provider, null, 2);
  const { component, decisions, resize } = dialog(text);
  for (const [width, height] of [[80, 24], [24, 15], [40, 18], [120, 30]]) {
    resize(height);
    component.handleInput("\x1b[H");
    const first = component.render(width);
    const budget = Math.floor(height * 0.7);
    const viewport = budget - 8;
    assert.equal(first.length, budget);
    assert.ok(first.every(line => visibleWidth(line) === width));
    const actions = first.slice(-5);
    const expected = plain(new Text(text, 0, 0).render(width - 4));
    const seen = [];
    component.handleInput("\x1b[H");
    component.render(width);
    for (let index = 0; index < expected.length; index++) {
      const lines = component.render(width);
      assert.deepEqual(lines.slice(-5), actions);
      // At the end, the viewport stops moving. Collect its remaining rows once.
      if (index <= expected.length - viewport) seen.push(...body(lines.slice(2, 3)));
      component.handleInput("\x1b[B");
    }
    const last = component.render(width);
    seen.push(...body(last.slice(3, 2 + viewport)));
    assert.deepEqual(seen, expected);
    assert.deepEqual(decisions, []);
  }
  component.dispose();
});

test("short confirmation fits its content after wrapping and terminal resize", () => {
  const text = "行情中文🙂".repeat(20);
  const { component, resize } = dialog(text);
  for (const [width, height] of [[80, 40], [24, 40], [24, 15], [120, 60]]) {
    resize(height);
    const lines = component.render(width);
    const content = plain(new Text(text, 0, 0).render(width - 4));
    const viewport = Math.min(content.length, Math.floor(height * 0.7) - 8);
    assert.equal(lines.length, viewport + 8);
    assert.deepEqual(body(lines.slice(2, 2 + viewport)), content.slice(0, viewport));
    assert.ok(lines.every(line => visibleWidth(line) === width));
  }
  component.dispose();
});

test("small height budget blocks approval even when the terminal has eight rows", () => {
  const { component, decisions, resize } = dialog("{}");
  component.render(80);
  resize(8);
  assert.ok(component.render(80).length <= Math.floor(8 * 0.7));
  component.handleInput("\r");
  assert.deepEqual(decisions, []);
  resize(15);
  component.render(80);
  component.handleInput("\x1b");
  assert.deepEqual(decisions, [false]);
});

test("approval is selected by default; scrolling does not approve and Tab selects cancellation", () => {
  const cancelled = dialog("{} ");
  cancelled.component.render(80);
  cancelled.component.handleInput("\x1b[B");
  assert.deepEqual(cancelled.decisions, []);
  cancelled.component.handleInput("\t");
  cancelled.component.handleInput("\r");
  assert.deepEqual(cancelled.decisions, [false]);
  const allowed = dialog("{}");
  allowed.component.render(80);
  allowed.component.handleInput("\r");
  allowed.component.handleInput("\r");
  assert.deepEqual(allowed.decisions, [true]);
});

test("abort, escape, and a terminal too small cannot authorize", () => {
  for (const action of ["abort", "escape", "small"]) {
    const controller = new AbortController();
    const { component, decisions, resize } = dialog("{}", controller.signal);
    component.render(80);
    if (action === "abort") controller.abort();
    else if (action === "escape") component.handleInput("\x1b");
    else {
      resize(3);
      assert.ok(component.render(12).length <= 3);
      component.handleInput("\r");
      assert.deepEqual(decisions, []);
      component.handleInput("\x1b");
    }
    component.handleInput("\r");
    assert.deepEqual(decisions, [false]);
  }
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(dialog("{}", controller.signal).decisions, [false]);
});

test("provider summary can switch to complete raw data without hiding actions and restores default approval", () => {
  const value = { operations: Array.from({ length: 40 }, (_, index) => ({ name: `op_${index}`, inputSchema: { type: "object" } })) };
  const raw = JSON.stringify(value, null, 2);
  const summary = "op_0()\nop_1()";
  const decisions = [];
  const component = new ConfirmationDialog("接入权限", raw, theme, keys, () => 24, () => {}, value => decisions.push(value), undefined, summary);
  const first = component.render(80);
  assert.equal(first.length, 11);
  assert.ok(first.every(line => visibleWidth(line) === 80));
  assert.deepEqual(body(first.slice(2, 4)), plain(new Text(summary, 0, 0).render(76)));
  component.handleInput("\t");
  component.handleInput("d");
  const full = component.render(80);
  assert.equal(full.length, 16);
  assert.deepEqual(full.slice(-6, -2), first.slice(-6, -2));
  assert.deepEqual(body(full.slice(2, 9)), plain(new Text(raw, 0, 0).render(76).slice(0, 7)));
  component.handleInput("\x1b[F");
  const end = component.render(80);
  assert.deepEqual(body(end.slice(2, 9)), plain(new Text(raw, 0, 0).render(76).slice(-7)));
  component.handleInput("d");
  assert.deepEqual(component.render(80), first);
  component.handleInput("\r");
  assert.deepEqual(decisions, [true]);
});
