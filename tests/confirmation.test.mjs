import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ConfirmationDialog } from "../dist/confirmation.js";

const theme = loadThemeFromPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url).pathname);
const keys = new KeybindingsManager();
function dialog(text, signal) {
  let rows = 24;
  const decisions = [];
  const component = new ConfirmationDialog("接入权限", text, theme, keys, () => rows, () => {}, value => decisions.push(value), signal);
  return { component, decisions, resize: height => { rows = height; } };
}

test("large confirmation keeps actions fixed and every wrapped detail line reachable", () => {
  const source = { operations: Array.from({ length: 200 }, (_, index) => ({ name: `operation_${index}`, description: "行情中文🙂", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } })) };
  const text = JSON.stringify(source, null, 2);
  const { component, decisions, resize } = dialog(text);
  for (const [width, height] of [[80, 24], [24, 8], [40, 12], [120, 30]]) {
    resize(height);
    component.handleInput("\x1b[H");
    const first = component.render(width);
    assert.equal(first.length, height);
    assert.ok(first.every(line => visibleWidth(line) <= width));
    const actions = first.slice(-4);
    const expected = new Text(text, 0, 0).render(width);
    const seen = [];
    component.handleInput("\x1b[H");
    component.render(width);
    for (let index = 0; index < expected.length; index++) {
      const lines = component.render(width);
      assert.deepEqual(lines.slice(-4), actions);
      // At the end, the viewport stops moving. Collect its remaining rows once.
      if (index <= expected.length - (height - 6)) seen.push(lines[1]);
      component.handleInput("\x1b[B");
    }
    const last = component.render(width);
    seen.push(...last.slice(2, 1 + height - 6));
    assert.deepEqual(seen, expected);
    assert.deepEqual(decisions, []);
  }
  component.dispose();
});

test("scrolling cannot select approval; approval requires explicit selection", () => {
  const cancelled = dialog("{} ");
  cancelled.component.render(80);
  cancelled.component.handleInput("\x1b[B");
  cancelled.component.handleInput("\r");
  assert.deepEqual(cancelled.decisions, [false]);
  const allowed = dialog("{}");
  allowed.component.render(80);
  allowed.component.handleInput("\t");
  allowed.component.handleInput("\r");
  allowed.component.handleInput("\r");
  assert.deepEqual(allowed.decisions, [true]);
});

test("abort, escape, and a terminal too small cannot authorize", () => {
  for (const action of ["abort", "escape", "small"]) {
    const controller = new AbortController();
    const { component, decisions, resize } = dialog("{}", controller.signal);
    component.render(80);
    component.handleInput("\t");
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

test("source summary can switch to complete raw data without hiding actions or keeping approval selected", () => {
  const value = { operations: Array.from({ length: 40 }, (_, index) => ({ name: `op_${index}`, inputSchema: { type: "object" } })) };
  const raw = JSON.stringify(value, null, 2);
  const summary = "op_0()\nop_1()";
  const decisions = [];
  const component = new ConfirmationDialog("接入权限", raw, theme, keys, () => 24, () => {}, value => decisions.push(value), undefined, summary);
  const first = component.render(80);
  assert.equal(first.length, 24);
  assert.deepEqual(first.slice(1, 3), new Text(summary, 0, 0).render(80));
  component.handleInput("\t");
  component.handleInput("d");
  const full = component.render(80);
  assert.equal(full.length, 24);
  assert.deepEqual(full.slice(1, 18), new Text(raw, 0, 0).render(80).slice(0, 17));
  component.handleInput("\x1b[F");
  const end = component.render(80);
  assert.deepEqual(end.slice(1, 18), new Text(raw, 0, 0).render(80).slice(-17));
  component.handleInput("d");
  assert.deepEqual(component.render(80), first);
  component.handleInput("\r");
  assert.deepEqual(decisions, [false]);
});
