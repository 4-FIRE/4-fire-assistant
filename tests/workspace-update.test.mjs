import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { begin } from "../dist/storage/workspace-state.js";
import { finish } from "../dist/services/initialization-service.js";
import { WorkspaceUpdateService } from "../dist/services/workspace-update-service.js";
import { readUpdateState, updateFile } from "../dist/storage/workspace-update.js";
import { approveLocally, localConfirmation } from "./helpers/local-confirmation.mjs";
import { localWorkspaceUpgrade } from "./helpers/local-workspace-upgrades.mjs";
import { host } from "./helpers/pi-host.mjs";

const signal = () => new AbortController().signal;
async function fixture(t, target = 2, ready = true) {
  const root = await mkdtemp(join(tmpdir(), "ffa-update-"));
  await begin(root);
  if (ready) await finish(root, "local");
  let store = new Store(join(root, ".ffa"));
  const upgrades = [];
  for (let from = 1; from < target; from++) {
    upgrades.push(localWorkspaceUpgrade(root, from));
    await writeFile(join(root, `requirements-${from + 1}.md`), `Local document requirement ${from + 1}`);
    await writeFile(join(root, `input-${from + 1}.txt`), `requirement ${from + 1}`);
  }
  let service = new WorkspaceUpdateService(root, store, upgrades, target);
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, upgrades, get store() { return store; }, get service() { return service; },
    async reopen() {
      await service.close(); store.close(); store = new Store(join(root, ".ffa"), false);
      service = new WorkspaceUpdateService(root, store, upgrades, target);
    },
  };
}
function plan(version) { return [{ path: `requirement-${version}.md`, change: "合并要求并保留已有事实" }]; }
function report(version) { return { modified: [`requirement-${version}.md`], unchanged: [], unresolved: [] }; }
async function program(f) {
  const current = await f.service.start(signal());
  const value = await f.service.plan(current.batch, current.from, plan(current.to), approveLocally, signal());
  assert.equal(value.stage, "documents"); return value;
}
async function document(f, version) { await writeFile(join(f.root, `requirement-${version}.md`), `User constraints; requirement ${version}`); }
async function backup(f, current, segment = 0) {
  const path = join(f.root, `.ffa/upgrades/v${current.from}-${current.batch}/${segment}`);
  return { path, manifest: JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) };
}

test("base version and no-op inspection do not persist progress or backups", async t => {
  const f = await fixture(t, 1);
  const before = await readdir(join(f.root, ".ffa"));
  assert.deepEqual(await f.service.inspect(), { version: 1, target: 1, pending: false, available: false });
  assert.deepEqual(await f.service.start(signal()), { version: 1, target: 1, done: true });
  assert.equal(f.store.get("workspace-update", "current"), undefined);
  assert.deepEqual(await readdir(join(f.root, ".ffa")), before);
  f.store.put("workspace-update", "current", { version: 4 });
  await assert.rejects(f.service.start(signal()));
  assert.equal(readUpdateState(f.store).version, 4);
});

test("pending, unrecognized and unreadable workspaces are not adopted", async t => {
  const f = await fixture(t, 2, false);
  await assert.rejects(f.service.start(signal()));
  const statePath = join(f.root, ".ffa/workspace.json");
  for (const value of ["broken", '{"format":"other","status":"ready"}']) {
    await writeFile(statePath, value);
    await assert.rejects(f.service.start(signal()));
    assert.equal(await readFile(statePath, "utf8"), value);
  }
  await rm(statePath);
  await assert.rejects(f.service.start(signal()));
  assert.equal(f.store.get("workspace-update", "current"), undefined);
});

test("complete chain and instructions are checked before progress is saved", async t => {
  const f = await fixture(t, 3);
  const missing = new WorkspaceUpdateService(f.root, f.store, [f.upgrades[0]], 3);
  await assert.rejects(missing.start(signal()));
  await rm(join(f.root, "requirements-3.md"));
  await assert.rejects(f.service.start(signal()));
  assert.equal(f.store.get("workspace-update", "current"), undefined);
  assert.equal((await readdir(join(f.root, ".ffa"))).includes("upgrades"), false);
});

test("rejected plan, omitted required files and aliases have no program effects", async t => {
  const f = await fixture(t), current = await f.service.start(signal());
  await assert.rejects(f.service.plan(current.batch, 1, [], approveLocally, signal()));
  const confirmation = localConfirmation();
  const pending = f.service.plan(current.batch, 1, plan(2), confirmation.ask, signal());
  const { dialog } = await confirmation.ready; dialog.handleInput("\u001b");
  await assert.rejects(pending);
  assert.equal(readUpdateState(f.store).batch.stage, "planning");
  assert.equal(f.store.get("local-requirement", "2"), undefined);
  await symlink(join(f.root, "input-2.txt"), join(f.root, "alias.md"));
  await assert.rejects(updateFile(f.root, "alias.md", false));
  await assert.rejects(updateFile(f.root, ".ffa/business.sqlite", false));
  await assert.rejects(updateFile(f.root, ".ffa/upgrades/old", true));
  await assert.rejects(updateFile(f.root, "../outside", false));
});

test("backups preserve existing and absent files, consistent ledger and original content on resume", async t => {
  const f = await fixture(t);
  const historical = { state: "unknown", attempt: { id: "sent" }, evidence: "Do not resend" };
  f.store.put("intent", "historical", historical);
  f.store.put("receipt", "receipt", { success: true, historical: true });
  await writeFile(join(f.root, "requirement-2.md"), "Original user constraints");
  await writeFile(join(f.root, ".ffa/permissions.json"), '{"default":"review","tools":{}}');
  f.upgrades[0].internalFiles.push(".ffa/permissions.json");
  const current = await f.service.start(signal());
  const value = await f.service.plan(current.batch, 1, [...plan(2), { path: "new.md", change: "新建相关资料" }], approveLocally, signal());
  const saved = await backup(f, value);
  const original = saved.manifest.files.find(file => file.path === "requirement-2.md");
  assert.equal(await readFile(join(saved.path, original.copy), "utf8"), "Original user constraints");
  assert.equal(saved.manifest.files.find(file => file.path === "new.md").existed, false);
  assert.ok(saved.manifest.files.some(file => file.path === ".ffa/permissions.json"));
  assert.ok(saved.manifest.files.every(file => !file.path.includes("upgrades")));
  const db = new DatabaseSync(join(saved.path, "business.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM records WHERE kind='intent' AND id='historical'").get().value), historical);
    assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='local-requirement'").get().n, 0);
  } finally { db.close(); }
  await document(f, 2); await f.reopen();
  assert.throws(() => f.service.resume(signal()));
  const resumed = await f.service.start(signal());
  assert.equal(resumed.batch, value.batch); assert.equal(resumed.stage, "documents");
  assert.equal(await readFile(join(saved.path, original.copy), "utf8"), "Original user constraints");
  assert.deepEqual(f.store.get("intent", "historical"), historical);
  assert.equal(f.store.get("receipt", "receipt").success, true);
});

test("backup failure stops scripts; script failure stops documents and following versions", async t => {
  const f = await fixture(t, 3), current = await f.service.start(signal());
  await writeFile(join(f.root, ".ffa/upgrades"), "blocked directory");
  await assert.rejects(f.service.plan(current.batch, 1, plan(2), approveLocally, signal()));
  assert.equal(f.store.get("local-requirement", "2"), undefined);
  await rm(join(f.root, ".ffa/upgrades"));
  await rm(join(f.root, "input-2.txt"));
  await assert.rejects(f.service.start(signal()));
  assert.equal(readUpdateState(f.store).batch.stage, "program");
  assert.equal(f.store.get("local-requirement", "3"), undefined);
  await writeFile(join(f.root, "input-2.txt"), "requirement 2");
  assert.equal((await f.service.start(signal())).stage, "documents");
});

test("saved program effects survive a phase-record failure without executing scripts again", async t => {
  const f = await fixture(t), current = await f.service.start(signal());
  const db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"));
  db.exec(`CREATE TRIGGER fail_phase BEFORE UPDATE ON records WHEN NEW.kind='workspace-update' AND json_extract(NEW.value,'$.batch.stage')='documents' BEGIN SELECT RAISE(ABORT,'phase write failed'); END`);
  await assert.rejects(f.service.plan(current.batch, 1, plan(2), approveLocally, signal()));
  assert.equal(f.store.get("local-requirement", "2").value, "requirement 2");
  assert.equal(readUpdateState(f.store).batch.stage, "program");
  db.exec("DROP TRIGGER fail_phase"); db.close();
  await rm(join(f.root, "input-2.txt")); // Re-execution would now fail.
  await f.reopen();
  assert.equal((await f.service.start(signal())).stage, "documents");
});

test("each version needs complete document checks and a separate completion confirmation", async t => {
  const f = await fixture(t, 3), current = await program(f);
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  await writeFile(join(f.root, "requirement-2.md"), "Nonempty but does not meet requirement");
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  await document(f, 2);
  await assert.rejects(f.service.complete(current.batch, 1, { ...report(2), unresolved: ["Missing fact"] }, approveLocally, signal()));
  const confirmation = localConfirmation();
  const pending = f.service.complete(current.batch, 1, report(2), confirmation.ask, signal());
  const { dialog } = await confirmation.ready; dialog.handleInput("\u001b"); await assert.rejects(pending);
  assert.equal(readUpdateState(f.store).version, 1);
  assert.equal(f.store.get("local-requirement", "3"), undefined);
  assert.deepEqual(await f.service.complete(current.batch, 1, report(2), approveLocally, signal()), { version: 2, target: 3, done: false });
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  const next = await program(f); assert.equal(next.from, 2);
  await document(f, 3);
  assert.equal((await f.service.complete(next.batch, 2, report(3), approveLocally, signal())).done, true);
  assert.equal(readUpdateState(f.store).version, 3);
  assert.equal(f.store.list("workspace-update-history").length, 2);
  assert.equal((await readdir(join(f.root, ".ffa/upgrades"))).length, 2);
});

test("scope changes need confirmation and extra backups without replacing the initial backup", async t => {
  const f = await fixture(t), current = await program(f), original = await backup(f, current);
  await writeFile(join(f.root, "extra.md"), "Extra original");
  await f.service.plan(current.batch, 1, [{ path: "extra.md", change: "补充升级资料" }], approveLocally, signal());
  const extra = await backup(f, current, 1);
  assert.deepEqual(extra.manifest.files.map(file => file.path), ["extra.md"]);
  assert.equal(await readFile(join(extra.path, extra.manifest.files[0].copy), "utf8"), "Extra original");
  assert.deepEqual((await backup(f, current)).manifest, original.manifest);
  await document(f, 2);
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  assert.equal((await f.service.complete(current.batch, 1, { ...report(2), unchanged: ["extra.md"] }, approveLocally, signal())).done, true);
});

test("version commit failure leaves the source version and can resume without repeating state changes", async t => {
  const f = await fixture(t), current = await program(f);
  await document(f, 2);
  const db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"));
  db.exec(`CREATE TRIGGER fail_version BEFORE UPDATE ON records WHEN NEW.kind='workspace-update' AND json_extract(NEW.value,'$.version')=2 BEGIN SELECT RAISE(ABORT,'version write failed'); END`);
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  assert.equal(readUpdateState(f.store).version, 1);
  assert.deepEqual(f.store.list("workspace-update-history"), []);
  db.exec("DROP TRIGGER fail_version"); db.close();
  await rm(join(f.root, "input-2.txt"));
  await f.reopen(); await f.service.start(signal());
  assert.equal((await f.service.complete(current.batch, 1, report(2), approveLocally, signal())).version, 2);
});

test("a single plan confirmation can cover the full chain while completion stays per version", async t => {
  const f = await fixture(t, 3), current = await f.service.start(signal());
  assert.deepEqual(current.chain.map(step => [step.from, step.to]), [[1, 2], [2, 3]]);
  await f.service.plan(current.batch, 1, plan(2), approveLocally, signal(), [{ from: 2, documents: plan(3) }]);
  assert.equal(f.store.get("local-requirement", "3"), undefined);
  await document(f, 2);
  await f.service.complete(current.batch, 1, report(2), approveLocally, signal());
  await f.reopen();
  const next = await f.service.start(signal());
  assert.equal(next.from, 2); assert.equal(next.stage, "documents");
  assert.equal(readUpdateState(f.store).version, 2);
  await document(f, 3);
  assert.equal((await f.service.complete(next.batch, 2, report(3), approveLocally, signal())).done, true);
});

test("changed declarations require renewed confirmation and preserve every original backup", async t => {
  const f = await fixture(t), current = await program(f), original = await backup(f, current);
  await writeFile(join(f.root, ".ffa/settings.json"), '{"strict":true}');
  f.upgrades[0].summary = "补充内部设置要求；保留已有权限。";
  f.upgrades[0].internalFiles.push(".ffa/settings.json");
  assert.equal((await f.service.resume(signal())).stage, "planning");
  await document(f, 2);
  await assert.rejects(f.service.complete(current.batch, 1, report(2), approveLocally, signal()));
  await f.service.plan(current.batch, 1, plan(2), approveLocally, signal());
  const supplement = await backup(f, current, 1);
  assert.deepEqual(supplement.manifest.files.map(file => file.path), [".ffa/settings.json"]);
  assert.deepEqual((await backup(f, current)).manifest, original.manifest);
  assert.equal((await f.service.complete(current.batch, 1, report(2), approveLocally, signal())).done, true);
});

test("a changed preapproved next version does not run without renewed confirmation", async t => {
  const f = await fixture(t, 3), current = await f.service.start(signal());
  await f.service.plan(current.batch, 1, plan(2), approveLocally, signal(), [{ from: 2, documents: plan(3) }]);
  await document(f, 2);
  await f.service.complete(current.batch, 1, report(2), approveLocally, signal());
  await writeFile(join(f.root, "requirements-3.md"), "Changed local document requirement 3");
  const next = await f.service.resume(signal());
  assert.equal(next.stage, "planning"); assert.equal(f.store.get("local-requirement", "3"), undefined);
  await f.service.plan(next.batch, 2, plan(3), approveLocally, signal());
  assert.equal(f.store.get("local-requirement", "3").value, "requirement 3");
});

test("missing published backup data stops resume without replacing the original backup", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "requirement-2.md"), "Original");
  const current = await program(f), saved = await backup(f, current);
  await document(f, 2);
  const copy = saved.manifest.files.find(file => file.path === "requirement-2.md").copy;
  await rm(join(saved.path, copy));
  await assert.rejects(f.service.resume(signal()));
  await assert.rejects(readFile(join(saved.path, copy)));
  assert.deepEqual((await backup(f, current)).manifest, saved.manifest);
  assert.equal(readUpdateState(f.store).version, 1);
});

test("close cancels an open confirmation and waits without starting program changes", async t => {
  const f = await fixture(t), current = await f.service.start(signal());
  let confirmation;
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const pending = f.service.plan(current.batch, 1, plan(2), (value, cancel) => {
    confirmation = localConfirmation(cancel);
    const decision = confirmation.ask(value);
    confirmation.ready.then(opened);
    return decision;
  }, signal());
  const failed = assert.rejects(pending);
  await ready;
  assert.throws(() => f.service.resume(signal()));
  await f.service.close(); await failed;
  assert.equal(readUpdateState(f.store).batch.stage, "planning");
  assert.equal(f.store.get("local-requirement", "2"), undefined);
  assert.throws(() => f.service.start(signal()));
});

test("Pi update command is read-only when ready at target and does not initialize inactive directories", async t => {
  for (const status of [undefined, "pending", "ready"]) {
    const f = await host(t, status), runner = f.session.extensionRunner;
    const before = await readdir(f.root);
    const messages = f.session.agent.state.messages.length;
    await runner.getCommand("ffa").handler("update", runner.createCommandContext());
    assert.deepEqual(await readdir(f.root), before);
    assert.equal(f.session.agent.state.messages.length, messages);
    if (status) assert.equal((await readdir(join(f.root, ".ffa"))).includes("upgrades"), false);
    if (status === "ready") {
      const db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='workspace-update'").get().n, 0); }
      finally { db.close(); }
    }
  }
});

test("Pi source loading exposes update tools only after initialization and rejects stale references", async t => {
  const pending = await host(t, "pending");
  assert.equal(pending.session.agent.state.tools.some(tool => tool.name === "ffa_finish_update"), false);
  const ready = await host(t, "ready");
  const tool = ready.session.agent.state.tools.find(tool => tool.name === "ffa_update_workspace");
  assert.ok(tool);
  await assert.rejects(tool.execute("unauthorized", { action: "resume" }));
  await ready.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  await ready.session.extensionRunner.emit({ type: "session_start" });
  await assert.rejects(tool.execute("stale", { action: "resume" }));
});
