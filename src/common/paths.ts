import { fileURLToPath } from "node:url";

export const resourceRoot = fileURLToPath(new URL("../../resources/", import.meta.url));
