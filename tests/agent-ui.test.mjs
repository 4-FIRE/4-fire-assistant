import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AgentViewer } from "../dist/ui/agent-viewer.js";
import { agentCard, agentBoard } from "../dist/ui/agent-display.js";
import { emptyAgentUsage } from "../dist/services/agent-usage.js";

const keys = new KeybindingsManager();
const themeFile = name => new URL(`../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`, import.meta.url).pathname;
async function until(condition) {
  for (let index = 0; index < 200; index++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Local viewer update did not finish");
}

test("viewer caches actual file reads, follows changes, scrolls and releases its watcher exactly once", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-viewer-")), path = join(root, "conversation");
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = Array.from({ length: 30 }, (_, index) => `record-${String(index).padStart(3, "0")}`).join("\n");
  await writeFile(path, content);
  let reads = 0, closes = 0, done = 0, rows = 24;
  const signal = new AbortController(), theme = loadThemeFromPath(themeFile("dark"));
  const viewer = new AgentViewer("中文🙂", async () => { reads++; return readFile(path, "utf8"); }, callback => {
    const watcher = watch(path, callback);
    return () => { closes++; watcher.close(); };
  }, () => rows, () => {}, () => { done++; }, keys, theme, signal.signal);
  t.after(() => viewer.dispose());
  const body = () => viewer.render(40).slice(1, -1).map(line => stripTerminalSequences(line).trimEnd());
  await until(() => body().some(line => line.includes("record-029")));
  viewer.handleInput("\x1b[H");
  assert.equal(body()[0], "record-000");
  viewer.handleInput("\x1b[6~"); assert.notEqual(body()[0], "record-000");
  viewer.handleInput("\x1b[F"); assert.ok(body().some(line => line.includes("record-029")));
  await writeFile(path, content + "\nrecord-030");
  await until(() => body().some(line => line.includes("record-030")));
  const before = reads;
  for (const [width, height] of [[1, 3], [24, 15], [80, 24], [120, 40]]) {
    rows = height; viewer.invalidate();
    const lines = viewer.render(width);
    assert.ok(lines.length <= Math.max(1, Math.floor(height * .8)));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.equal(reads, before);
  signal.abort(); viewer.dispose(); viewer.finish();
  assert.equal(closes, 1); assert.equal(done, 1);
});

test("truncated agent cards preserve the native tool background through ellipses and padding", () => {
  const value = { runId: "execution-id", agent: "researcher", message: "行情中文🙂".repeat(40),
    mode: "background", state: "running", createdAt: Date.now(), activity: "tool-name",
    report: "计算中文🙂".repeat(40), usage: emptyAgentUsage() };
  for (const name of ["dark", "light"]) {
    const theme = loadThemeFromPath(themeFile(name));
    for (const background of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
      for (const width of [4, 12, 40]) {
        for (const expanded of [false, true]) {
          const box = new Box(1, 0, text => theme.bg(background, text));
          box.addChild(agentCard(value, expanded, theme, background));
          const lines = box.render(width);
          assert.ok(lines.some(line => stripTerminalSequences(line).includes(".".repeat(Math.min(3, width - 2)))));
          for (const line of lines) {
            assert.equal(visibleWidth(line), width);
            // SGR 0 clears the inherited Box background. Reapply it before any following glyph or padding.
            for (const afterReset of line.split("\x1b[0m").slice(1)) {
              assert.ok(afterReset.startsWith(theme.getBgAnsi(background)));
            }
          }
        }
      }
    }
  }
});

test("agent cards and running boards fit narrow widths and hide finished executions", () => {
  const value = { runId: "execution-id", agent: "researcher", message: "行情中文🙂".repeat(40),
    mode: "background", state: "running", createdAt: Date.now(), activity: "tool-name", report: "计算中文🙂",
    usage: emptyAgentUsage() };
  for (const name of ["dark", "light"]) {
    const theme = loadThemeFromPath(themeFile(name));
    const running = Array.from({ length: 5 }, (_, index) => ({ ...value, runId: "running-" + index }));
    const queued = Array.from({ length: 100 }, (_, index) => ({ ...value, runId: "queued-" + index, state: "queued" }));
    for (const width of [1, 2, 24, 40, 120]) {
      for (const state of ["queued", "running", "completed", "failed", "cancelled", "interrupted"]) {
        for (const expanded of [false, true]) {
          const card = agentCard({ ...value, state, error: "error detail\n中文🙂" }, expanded, theme, "toolPendingBg");
          card.invalidate();
          assert.ok(card.render(width).every(line => visibleWidth(line) <= width && !line.includes("\n")));
        }
      }
      const board = agentBoard([...running, ...queued], theme, 5);
      board.invalidate();
      const lines = board.render(width);
      assert.equal(lines.length, 6);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
    assert.deepEqual(agentBoard([{ ...value, state: "completed", finishedAt: Date.now() }], theme, 5).render(40), []);
    assert.equal(agentBoard(queued, theme, 5).render(40).length, 1);
  }
});
