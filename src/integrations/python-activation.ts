import { delimiter, join } from "node:path";

/** Like venv activation, scoped to this Pi process; never edits shell configuration. */
export function activatePython(directory: string): () => void {
  const values: Record<string, string | undefined> = {
    PATH: join(directory, "bin") + delimiter + (process.env.PATH ?? "/usr/bin:/bin"),
    VIRTUAL_ENV: directory,
    PYTHONHOME: undefined,
    PYTHONPATH: undefined,
    PYTHONNOUSERSITE: "1",
  };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  for (const [key, value] of Object.entries(values)) assign(key, value);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of previous) if (process.env[key] === values[key]) assign(key, value);
  };
}
