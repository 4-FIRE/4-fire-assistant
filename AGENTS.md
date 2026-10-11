# Repository Guidelines

## Structure

FFA is a workspace-scoped Pi extension package, not a standalone CLI.

- `src/index.ts`: Pi commands, tools, resource discovery, and lifecycle.
- `src/workspace.ts`: activation, initialization, and path rules.
- `src/sources.ts`: native CLI and MCP operations.
- `src/storage.ts`, `src/trading.ts`: durable business records and controlled execution.
- `src/experts.ts`: isolated Pi expert sessions.
- `src/research.ts`: ordinary Python runs and artifacts.
- `resources/`: roles, skills, and references.
- `tests/`: necessary Node tests using real local logic and the Pi SDK.
- `python/`: optional calculation library and its algorithm tests.
- `docs/`: architecture, migration status, and decisions.
- `dist/`: generated test imports. Do not edit generated files.

Read `docs/technical-design.md` and `docs/migration-plan.md` before changing runtime boundaries. Old code and tests are references, not compatibility requirements. Delete unused repository code rather than adding adapters. Never delete user workspaces or historical trading records as part of this cleanup.

## Commands

Use Linux and Node.js 22.19 or later. Computation requires Python 3.11+.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: check TypeScript without emitting files.
- `npm run build`: compile test imports into dist.
- `npm test`: build and run Node tests serially.
- `npm pack --dry-run`: inspect package contents.

Pi loads the source extension with jiti. The package does not require compiled JavaScript at runtime. Declare host-provided packages as peers, not runtime dependencies.

## FFA

从投资工作区根目录使用 `pi`。本地包安装方式见 README。

未初始化时只提示 `/ffa init`，不接管普通 Pi 工作。初始化中断不自动继续；完成后通过原生 `/reload` 刷新能力，以后启动自动启用，但不自动开展业务。

接受 Pi 原生恢复，不引入 pi-durable 或另建通用任务运行时。交易账本独立于聊天分支，可能已发送的交易不得自动重发。

## Development Principles

- Use the simplest solution that meets an established requirement.
- Prefer Pi tools, UI, resource discovery, configuration, and sessions over custom equivalents.
- Define roles in documents and professional methods in skills.
- Keep business decisions separate from host integration.
- Keep each module focused. Do not add unused interfaces or forwarding layers.
- Do not create a plugin platform, fixed research workflow, compatibility layer, or second main agent.
- Keep tools inactive until the workspace enables them.
- Check trading permissions at the actual send boundary, not only in prompts or tool hooks.
- Do not claim host isolation for Bash, Python, or extensions.
- Do not add file hash verification in code, tests, builds, or checks.

## Style

Use TypeScript ESM, two-space indentation, double quotes, semicolons, and `.js` suffixes in relative imports. Use `import type` for type-only imports. Keep strict compiler checks.

Use camelCase for variables and functions, PascalCase for types, and kebab-case for multiword filenames. Keep service details in their integration.

## Tests

Use `node:test` and `node:assert/strict`. Import compiled modules from dist. Test concrete correctness risks, not coverage counts or implementation structure.

Do not use mocks, stubs, fake models, simulated services, real trades, or personal credentials. Use actual local files, SQLite, processes, calculations, and Pi SDK behavior.

Do not test documentation, prompt text, labels, or message wording. Parsing and serialization may verify structured values when they form the logic contract.

Real model and external service acceptance requires an approved environment. Record remaining gaps; local tests do not prove those behaviors.

## Submission

Use concise `feat:` or `fix:` commit prefixes. Keep changes focused.

Update design and usage docs when behavior changes. Run `npm run check`, `npm test`, and `git diff --check` before submission. Keep credentials, runtime databases, and local configuration out of commits.
