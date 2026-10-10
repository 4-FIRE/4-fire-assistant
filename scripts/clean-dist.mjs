import { rm } from "node:fs/promises";

// Remove generated modules whose source was deleted.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
