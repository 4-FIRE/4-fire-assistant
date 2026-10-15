import { access as fileAccess, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { defineTool, createWriteToolDefinition, createEditToolDefinition,
  type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Native tools still own parsing, mutation queues and results; authorize at the actual file write. */
export function agentFileTools(root: string, signal: AbortSignal,
  authorize: (path: string, change: unknown, signal: AbortSignal) => Promise<void>): ToolDefinition[] {
  const guardedWrite = (cancel: AbortSignal, parameters: unknown) => async (path: string, content: string) => {
    await authorize(path, { parameters, content }, cancel);
    await mkdir(dirname(path), { recursive: true });
    cancel.throwIfAborted();
    await writeFile(path, content, "utf8");
  };
  return [
    defineTool({ ...createWriteToolDefinition(root),
      execute(id, args, inner, update, child) {
        const cancel = AbortSignal.any([signal, ...(inner ? [inner] : [])]);
        return createWriteToolDefinition(root, { operations: {
          // Directory creation belongs to guardedWrite, after authorization.
          mkdir: async () => {}, writeFile: guardedWrite(cancel, args),
        } }).execute(id, args, cancel, update, child);
      },
    }),
    defineTool({ ...createEditToolDefinition(root),
      execute(id, args, inner, update, child) {
        const cancel = AbortSignal.any([signal, ...(inner ? [inner] : [])]);
        return createEditToolDefinition(root, { operations: {
          readFile, access: path => fileAccess(path, constants.R_OK | constants.W_OK), writeFile: guardedWrite(cancel, args),
        } }).execute(id, args, cancel, update, child);
      },
    }),
  ];
}
