import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

class PiProcess {
  records = [];
  waiters = new Set();
  stderr = "";
  sequence = 0;
  exited = false;

  constructor(root, agentDir, home, packagePath) {
    this.child = fork(new URL("./pi-rpc-driver.mjs", import.meta.url), [root, agentDir, packagePath], {
      cwd: root, execArgv: [], silent: true,
      // Do not inherit API keys, user settings, extensions, or credential helpers.
      env: { HOME: home, XDG_DATA_HOME: join(home, "data"), PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PI_CODING_AGENT_DIR: agentDir },
    });
    this.child.stderr.setEncoding("utf8").on("data", text => { this.stderr = (this.stderr + text).slice(-16_000); });
    let buffer = "";
    this.child.stdout.setEncoding("utf8").on("data", text => {
      buffer += text;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { this.publish(JSON.parse(line)); }
        catch (error) { this.fail(error); }
      }
    });
    this.child.on("message", record => this.publish(record));
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.exited = true;
      this.fail(new Error(`Pi exited (${code ?? signal})\n${this.stderr}`));
      resolve({ code, signal });
    }));
  }

  fail(error) {
    this.failure = error;
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }

  publish(record) {
    this.records.push(record);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(record)) waiter.resolve(record);
    }
  }

  waitFor(match, since = 0) {
    const existing = this.records.slice(since).find(match);
    if (existing) return Promise.resolve(existing);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        callback(value);
      };
      const waiter = { match, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      const timer = setTimeout(() => waiter.reject(new Error(`Pi response timed out\n${this.stderr}\n${JSON.stringify(this.records.slice(-5))}`)), 15_000);
      this.waiters.add(waiter);
    });
  }

  send(record) { this.child.stdin.write(JSON.stringify(record) + "\n"); }

  async request(type, fields = {}) {
    const id = `rpc-${++this.sequence}`;
    const response = this.waitFor(record => record.type === "response" && record.id === id);
    this.send({ id, type, ...fields });
    const result = await response;
    assert.equal(result.success, true, result.error);
    return result.data;
  }

  async driver(action, fields = {}) {
    const id = `driver-${++this.sequence}`;
    const response = this.waitFor(record => record.type === "driver_response" && record.id === id);
    this.child.send({ id, action, ...fields });
    const result = await response;
    if (!result.success) throw new Error(result.error);
    return result.value;
  }

  command(message) { return this.request("prompt", { message }); }
  inspect() { return this.driver("inspect"); }
  execute(name, input = {}) { return this.driver("execute", { name, input }); }

  async tool(name, input = {}) {
    const result = await this.execute(name, input);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent, `${name} must return structured data`);
    return result.structuredContent;
  }

  async confirm(operation, confirmed = true) {
    const request = this.waitFor(record => record.type === "extension_ui_request" && record.method === "confirm", this.records.length);
    const answer = request.then(record => this.send({ type: "extension_ui_response", id: record.id, confirmed }));
    const [value] = await Promise.all([operation(), answer]);
    return value;
  }

  async stop() {
    if (this.exited) return this.closed;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    try { return await this.closed; }
    finally { clearTimeout(timer); }
  }
}

export async function rpcWorkspace(t) {
  const temp = await mkdtemp(join(tmpdir(), "ffa-e2e-"));
  const root = join(temp, "workspace"), agentDir = join(temp, "agent"), home = join(temp, "home");
  const processes = [];
  t.after(async () => {
    try {
      const exits = await Promise.all(processes.map(process => process.stop()));
      for (const exit of exits) assert.deepEqual(exit, { code: 0, signal: null });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  await Promise.all([root, agentDir, home].map(path => mkdir(path)));
  // A real invalid target exercises startup warnings without downloading dependencies.
  await mkdir(join(home, "data/ffa/python/.venv"), { recursive: true });
  return {
    root, temp,
    async start(packagePath = packageRoot) {
      const pi = new PiProcess(root, agentDir, home, packagePath);
      processes.push(pi);
      await pi.request("get_state");
      return pi;
    },
  };
}

export async function initialize(pi) {
  await pi.confirm(() => pi.command("/ffa init"));
  // No credentials are installed. The initialization model handoff cannot run;
  // tests submit the finish tool explicitly, without substituting a model.
  await pi.driver("idle");
  const result = await pi.confirm(() => pi.tool("ffa_finish_initialization"));
  assert.equal(result.ready, true);
  await pi.command("/ffa init"); // Ready workspaces use the native ctx.reload().
}
