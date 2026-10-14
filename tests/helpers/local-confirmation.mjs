import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ConfirmationDialog } from "../../dist/ui/confirmation.js";

const theme = loadThemeFromPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url).pathname);

// Exercise the real confirmation component. This is not a host TUI/RPC acceptance test.
export function localConfirmation(signal) {
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  return { ready, ask: (value, _recheck, cancel = signal) => new Promise(resolve => {
    const dialog = new ConfirmationDialog("Local operation", JSON.stringify(value), theme, new KeybindingsManager(),
      () => 24, () => {}, resolve, cancel);
    dialog.render(80);
    opened({ dialog, value });
  }) };
}
export async function approveLocally(value) {
  const confirmation = localConfirmation();
  const decision = confirmation.ask(value);
  const { dialog } = await confirmation.ready;
  dialog.handleInput("\r");
  return decision;
}
