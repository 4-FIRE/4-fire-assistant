const host = "(?:^|/)node_modules/(?:@earendil-works/pi-(?:coding-agent|ai|tui|mcp)|typebox)(?:/|$)";

module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: { path: "^src/" }, to: { circular: true } },
    { name: "resolved-imports", severity: "error", from: { path: "^src/" }, to: { couldNotResolve: true } },
    { name: "model-is-data", severity: "error", from: { path: "^src/model/" },
      to: { path: "^src/(?:services|tools|storage|integrations|extension|ui)/|^src/ffa\\.ts$|" + host } },
    { name: "common-is-independent", severity: "error", from: { path: "^src/common/" },
      to: { path: "^src/(?!common/)|" + host } },
    { name: "services-are-host-neutral", severity: "error", from: { path: "^src/services/" },
      to: { path: "^src/(?:tools|extension|ui)/|^src/ffa\\.ts$|" + host } },
    { name: "services-use-host-capabilities", severity: "error", from: { path: "^src/services/" },
      to: { path: "^src/integrations/", pathNot: "^src/integrations/process\\.ts$" } },
    { name: "api-does-not-access-storage", severity: "error", from: { path: "^src/tools/|^src/extension/command\\.ts$" },
      to: { path: "^src/storage/|^src/integrations/(?:private-mcp|cli-provider|provider-connections|process)\\.ts$" } },
    { name: "integrations-do-not-run-services", severity: "error", from: { path: "^src/integrations/" },
      to: { path: "^src/services/", preCompilationOnly: false } },
    { name: "storage-does-not-decide-business", severity: "error", from: { path: "^src/storage/" },
      to: { path: "^src/(?:services|tools|integrations|extension|ui)/|^src/ffa\\.ts$|" + host } },
    { name: "ui-does-not-decide-business", severity: "error", from: { path: "^src/ui/" },
      to: { path: "^src/(?:services|tools|storage|integrations|extension)/|^src/ffa\\.ts$" } },
    { name: "composition-is-not-a-dependency", severity: "error", from: { path: "^src/" },
      to: { path: "^src/ffa\\.ts$" } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: "specify",
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "node", "default"] },
  },
};
