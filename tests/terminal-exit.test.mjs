import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { saveWorkspace } from "../dist/infrastructure/workspace.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";

const exec = promisify(execFile);
const terminalRun = `
import json, os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
sent = False
raw_at = None
deadline = time.monotonic() + 8
try:
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
        if not sent:
            raw = not (termios.tcgetattr(master)[3] & termios.ICANON)
            if raw and raw_at is None:
                raw_at = time.monotonic()
            if raw_at is not None and time.monotonic() - raw_at > 0.3:
                os.write(master, bytes.fromhex(sys.argv[1]))
                sent = True
    try:
        code = child.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        code = None
    restored = bool(termios.tcgetattr(master)[3] & termios.ICANON)
    print(json.dumps({"sent": sent, "code": code, "restored": restored}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
`;

for (const [name, input] of [["/quit", "/quit\r"], ["Ctrl+D", "\x04"]]) {
  test(`${name} exits the real CLI after cleanup despite a retained I/O handle`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "ffa-terminal-exit-")), directory = join(root, ".ffa");
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(directory);
    await saveWorkspace(directory, emptyWorkspace());
    // A real OS watcher keeps Node alive unless the executable finishes explicitly.
    // No model, service or terminal implementation is replaced.
    const preload = join(root, "watch.mjs");
    await writeFile(preload, 'import { watch } from "node:fs"; watch(process.cwd(), () => {});\n');
    const { stdout } = await exec("python3", ["-c", terminalRun, Buffer.from(input).toString("hex"),
      process.execPath, "--import", preload, fileURLToPath(new URL("../dist/main.js", import.meta.url)),
      "--model", "openai/gpt-4.1", "--auth-file", join(root, "auth.json"), "--models-file", join(root, "models.json")], {
      cwd: root, timeout: 12000,
      env: { PATH: process.env.PATH, HOME: root, TERM: "xterm-256color", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") },
    });
    assert.deepEqual(JSON.parse(stdout), { sent: true, code: 0, restored: true });
    const storage = await openApplicationStorage(directory);
    await storage.close();
  });
}
