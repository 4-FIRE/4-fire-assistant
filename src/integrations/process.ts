import { spawn } from "node:child_process";
import type { Json } from "../common/json.js";
import type { Observation } from "../model/receipt.js";

export function processEnvironment(env: Record<string, string>) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...env };
}

export async function runCommand(command: string, args: string[], input: string | undefined, cwd: string,
  env: Record<string, string>, signal?: AbortSignal, options: { timeoutMs?: number } = {}): Promise<Observation> {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: processEnvironment(env), shell: false,
      detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0, failed = false;
    const out: Buffer[] = [], err: Buffer[] = [];
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ } } };
    const stop = () => { failed = true; kill(); };
    const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
    signal?.addEventListener("abort", stop, { once: true });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop(); else target.push(chunk);
    };
    child.stdout.on("data", collect(out)); child.stderr.on("data", collect(err));
    child.on("error", stop); child.stdin.on("error", stop);
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop); kill();
      const text = Buffer.concat(out).toString("utf8");
      let data: Json = { stdout: text, stderr: Buffer.concat(err).toString("utf8"), exitCode: code };
      try { data = JSON.parse(text) as Json; } catch { /* Preserve text and exit code. */ }
      resolve({ success: !failed && !signal?.aborted && code === 0, data, raw: { stdout: text, stderr: Buffer.concat(err).toString("utf8"), exitCode: code, incomplete: failed || !!signal?.aborted } });
    });
    if (signal?.aborted) stop(); child.stdin.end(input);
  });
}
