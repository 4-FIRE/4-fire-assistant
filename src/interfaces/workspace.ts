import { AssistantError } from "../application/ports.js";
import { AssistantScreen } from "./screen.js";

export async function confirmWorkspaceCreation(root: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new AssistantError("WORKSPACE_CONFIRMATION_REQUIRED", "请在交互终端确认创建工作区。");
  const screen = new AssistantScreen();
  screen.setHeader("4-FIRE · 创建工作区");
  screen.setTranscript("产品资料保存在 .ffa；不会覆盖当前目录的 AGENTS.md，也不会迁移旧工作区。");
  screen.onQuit = () => screen.stop();
  const interrupt = () => screen.stop();
  process.on("SIGINT", interrupt);
  try {
    screen.start();
    return await screen.choose(`是否在此目录创建 .ffa 工作区？\n${root}`, [
      { value: "cancel", label: "取消" }, { value: "create", label: "确认创建" },
    ]) === "create";
  } finally { process.off("SIGINT", interrupt); screen.stop(); }
}
