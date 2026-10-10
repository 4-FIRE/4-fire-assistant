import { Research } from "../../dist/infrastructure/research.js";
const [workspace, runtimeDirectory] = process.argv.slice(2);
const research = new Research(workspace, { runtimeDirectory });
await research.run({
  project: "interrupted",
  code: "import time\nprint(17, flush=True)\ntime.sleep(60)",
  inputs: { experiment: 1 },
  evidence: [],
});
