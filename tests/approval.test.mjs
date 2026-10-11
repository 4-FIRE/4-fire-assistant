import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalApproval } from "../dist/interfaces/approval.js";
import { AssistantScreen } from "../dist/interfaces/screen.js";

const confirmation = (intentId, revision = 1) => ({
  intentId, revision, operation: { name: "local/operation", parameters: { quantity: 1 } },
  binding: { connectionId: "local", epoch: "current", accessDigest: "access", schemaDigest: "schema" },
  description: "Local confirmation only; no service call",
});
// Let the real confirmation queue advance without starting a terminal input loop.
async function advance() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(t) {
  const screen = new AssistantScreen();
  const approval = new TerminalApproval(undefined, true);
  approval.attachScreen(screen);
  t.after(() => { approval.revoke(); screen.stop(); });
  const input = key => screen.tui.getFocusedComponent().handleInput(key);
  return { screen, approval, input };
}

test("confirmation defaults to refusal; text and paste cannot select approval", async t => {
  const { approval, screen, input } = setup(t);
  screen.editor.setText("unfinished draft");
  const pending = approval.confirm(confirmation("first"));
  await advance();
  assert.equal(screen.dialogOpen, true);
  input("confirm");
  input("\x1b[200~\x1b[B\r\x1b[201~");
  input("\r");
  assert.equal(await pending, false);
  assert.equal(screen.dialogOpen, false);
  assert.equal(screen.editor.getText(), "unfinished draft");
});

test("queued confirmations remain separate; stale commands cannot approve a new version", async t => {
  const { approval, screen, input } = setup(t);
  const first = approval.confirm(confirmation("first"));
  const second = approval.confirm(confirmation("second", 2));
  await advance();
  assert.throws(() => approval.respond("second", 1, true), { code: "APPROVAL_MISMATCH" });
  input("\x1b[B");
  input("\r");
  assert.equal(await first, true);
  await advance();
  assert.equal(screen.dialogOpen, true);
  input("\x1b");
  assert.equal(await second, false);
  assert.throws(() => approval.respond("first", 1, true), { code: "APPROVAL_MISMATCH" });
});

test("abort and revoke close active dialogs and discard queued approvals", async t => {
  const { approval, screen, input } = setup(t);
  const controller = new AbortController();
  const first = approval.confirm(confirmation("first"), controller.signal);
  const second = approval.confirm(confirmation("second"));
  await advance();
  controller.abort();
  assert.equal(await first, false);
  await advance();
  input("\x1b[B");
  const third = approval.confirm(confirmation("third"));
  approval.revoke();
  assert.deepEqual(await Promise.all([second, third]), [false, false]);
  await advance();
  assert.equal(screen.dialogOpen, false);
  assert.throws(() => approval.respond("second", 1, true), { code: "APPROVAL_MISMATCH" });
});

test("control commands close their exact dialog without cancelling the next request", async t => {
  const { approval, screen, input } = setup(t);
  const first = approval.confirm(confirmation("first"));
  const second = approval.confirm(confirmation("second"));
  await advance();
  approval.respond("first", 1, false);
  assert.equal(await first, false);
  await advance();
  assert.equal(screen.dialogOpen, true);
  input("\x1b[B");
  input("\r");
  assert.equal(await second, true);
});

test("noninteractive confirmation cannot acquire permission", () => {
  const approval = new TerminalApproval(undefined, false);
  assert.throws(() => approval.confirm(confirmation("first")), { code: "APPROVAL_NEEDS_TTY" });
});
