export class WorkspaceState {
  declare format: `ffa/${string}`;
  declare status: "pending" | "ready";
  declare market?: string;
  constructor(value: WorkspaceState) { Object.assign(this, value); }
}
