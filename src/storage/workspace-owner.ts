import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireThat } from "../common/validation.js";
import { internalPath } from "./atomic-json.js";

/** Linux flock locks the shared open file description until this process closes it. */
export class WorkspaceOwner {
  readonly #fd: number;
  #closed = false;
  constructor(directory: string) {
    this.#fd = openSync(internalPath(directory, "owner.lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      requireThat(fstatSync(this.#fd).isFile(), "工作区所有权文件必须是普通文件。");
      // The child inherits this descriptor. Its exit does not release the parent's lock.
      const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", this.#fd], timeout: 5_000,
      });
      requireThat(!result.error && result.status === 0,
        "无法取得工作区所有权；请确认 util-linux flock 可用且没有其他 ffa 实例正在使用此工作区。");
    } catch (error) { closeSync(this.#fd); throw error; }
  }
  close() {
    if (this.#closed) return;
    closeSync(this.#fd); this.#closed = true;
  }
}
