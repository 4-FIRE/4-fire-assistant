import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { packageVersion, workspaceFormat, workspaceFormatFor } from "../../dist/common/version.js";

test("runtime release and workspace format come from the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageVersion, manifest.version);
  assert.equal(workspaceFormat, workspaceFormatFor(manifest.version));
});

test("patch releases share a format and incompatible release lines do not", () => {
  for (const version of ["0.3.0", "0.3.1", "0.3.42", "0.3.1-rc.1+local"]) {
    assert.equal(workspaceFormatFor(version), "ffa/0.3");
  }
  assert.equal(workspaceFormatFor("0.4.0"), "ffa/0.4");
  for (const version of ["1.0.0", "1.1.0", "1.42.3"]) assert.equal(workspaceFormatFor(version), "ffa/1");
  assert.equal(workspaceFormatFor("2.0.0"), "ffa/2");
  for (const version of ["", "0.3", "v0.3.0", "01.2.3", "0.x.0"]) {
    assert.throws(() => workspaceFormatFor(version));
  }
});
