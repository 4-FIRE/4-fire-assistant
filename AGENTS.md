# Repository Guidelines

## Structure

FFA is a workspace-scoped Pi extension package, not a standalone CLI.

- `src/index.ts`: dependency assembly and registration.
- `src/tools/`: complete tool contracts, execution adapters, and explicit tool lists.
- `src/services/`: business rules, state changes, and operation order.
- `src/model/`: data-only business classes; no business behavior or Pi types.
- `src/integrations/`: Pi sessions, MCP, CLI, and process execution.
- `src/storage/`: SQLite reliability, ownership, and workspace state files.
- `src/extension/`: commands, events, activation, and resource lifetime.
- `src/ui/`: confirmation queue, dialogs, and source display.
- `src/common/`: shared JSON, validation, file, and package-path helpers.
- `resources/`: roles, skills, and references.
- `tests/`: necessary Node tests using real local logic and the Pi SDK.
- `python/`: optional calculation library and its algorithm tests.
- `docs/`: architecture, migration status, and decisions.
- `dist/`: generated test imports. Do not edit generated files.

Read `docs/architecture-guidelines.md` for general design requirements. Read `docs/refactoring-design.md` for module boundaries. Read `docs/technical-design.md`, `docs/capability-design.md`, and `docs/migration-plan.md` before changing runtime boundaries. Old code and tests are references, not compatibility requirements. Do not support historical workspace formats or add migration, conversion, or default-field adapters. Delete unused repository code rather than adding adapters. Never delete user workspaces or historical trading records as part of this cleanup.

## Commands

Use Linux and Node.js 22.19 or later. Computation requires Python 3.11+.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: check TypeScript and dependency boundaries without emitting files.
- `npm run check:dependencies`: check imports and cycles with dependency-cruiser.
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
- Keep business decisions separate from host integration. Services receive plain data and narrow capabilities, not complete Pi contexts.
- Keep tool inputs, outputs, schemas, and execution adapters together. Commands and tools call the same services.
- Keep state changes in their owning services. Bind tools to one workspace instance and reject stale calls after close.
- Keep each module focused. Do not add unused interfaces or forwarding layers.
- Do not create a plugin platform, fixed research workflow, compatibility layer, or second main agent.
- Keep tools inactive until the workspace enables them.
- Keep every discovered source capability in the catalog, including unresolved, blocked, and unavailable operations.
- Separate business purpose, state effect, and execution requirements. Do not classify a service by its name.
- Check change permissions at the actual send boundary, not only in prompts or tool hooks. Trading still requires independent review.
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
