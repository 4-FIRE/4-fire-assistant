import type { WorkspaceUpgrade } from "../workspace-update-contract.js";

// Package changes alone do not increase the workspace requirements.
export const targetWorkspaceVersion = 1;
export const workspaceUpgrades: readonly WorkspaceUpgrade[] = [];
