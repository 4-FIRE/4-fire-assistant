export class WorkspaceState {
  declare format: "ffa-pi/2";
  declare status: "pending" | "ready";
  declare market?: string;
  constructor(value: WorkspaceState) { Object.assign(this, value); }
}
