# Repository Guidelines

## Structure

ffa is a workspace-scoped Pi extension package, not a standalone CLI.

- `src/ffa.ts`: dependency assembly and registration.
- `src/tools/`: complete tool contracts, execution adapters, and explicit tool lists.
- `src/services/`: business rules, state changes, and operation order.
- `src/model/`: data-only business classes; no business behavior or Pi types.
- `src/integrations/`: Pi sessions, MCP, CLI, and process execution.
- `src/storage/`: atomic JSON, domain file storage, and workspace state files.
- `src/extension/`: commands, events, activation, and resource lifetime.
- `src/ui/`: confirmation queue, dialogs, and provider display.
- `src/common/`: shared JSON, validation, file, and package-path helpers.
- `resources/`: roles, skills, and references.
- `tests/`: necessary Node tests using real local logic and the Pi SDK.
- `python/`: locked calculation dependencies, usage guidance, and native-library integration tests.
- `docs/`: current architecture and validation limits.
- `scripts/`: build helpers, shared Python venv preparation, and standalone workspace upgrades.
- `dist/`: generated test imports. Do not edit generated files.

Keep the top-level layers. Group related files by domain within a layer: services use `providers/`, `agents/`, `execution/`, and `workspace/`; integrations use `providers/` and `pi/`; tool contracts stay beside their domain tools. Tests use domain subdirectories under `tests/`.

Read `docs/architecture-guidelines.md` for general design requirements. Read `docs/technical-design.md` for module boundaries and validation limits. Read `docs/capability-design.md` before changing provider discovery or execution permissions. 0.3.0 is the baseline. The extension supports only the current workspace format; it has no upgrade command, historical readers, or runtime compatibility layer. Future workspace upgrades belong in standalone scripts under `scripts/`, outside the extension lifecycle. Each actual upgrade must declare supported source and target formats, require a stopped workspace, back up before changes, validate results, and support explicit resumption after interruption. Do not migrate automatically at startup or silently fill missing fields during normal loading. Delete unused repository code. Never delete user workspaces or historical trading records.

Release versions use `MAJOR.MINOR.PATCH` from `package.json`; bundled components share that release. Derive the workspace format from its compatibility line: `ffa/0.MINOR` before 1.0, then `ffa/MAJOR`. Keep the persisted contract unchanged within a line. Data changes requiring conversion must start a new line; do not add separate storage or upgrade version counters. Name standalone conversions `upgrade-<source-baseline>-to-<target-baseline>.mjs`.

## Commands

Use Linux with Node.js 22.19 or later. Computation requires Python 3.11+.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: check TypeScript and dependency boundaries without emitting files.
- `npm run check:dependencies`: check imports and cycles with dependency-cruiser.
- `npm run build`: compile test imports into dist.
- `npm test`: build and run Node tests serially.
- `npm pack --dry-run`: inspect package contents.

Pi loads the source extension with jiti. The package does not require compiled JavaScript at runtime. Declare host-provided packages as peers, not runtime dependencies.

## ffa

从工作区根目录使用 `pi`。本地包安装方式见 README。

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
- Use narrow strategies for existing protocol differences. Keep approval, persistence, and state rules in their owning services. Register implementations explicitly; do not add dynamic plugin discovery.
- Do not create a plugin platform, fixed research workflow, or second main agent. Keep workspace upgrades in independent scripts, not in the extension runtime.
- Keep tools inactive until the workspace enables them.
- Keep every discovered provider capability in the catalog, including unresolved, blocked, and unavailable operations.
- Keep native capability facts separate from user tool permissions. Do not classify a provider by its name.
- Check tool permissions at the actual send boundary, not only in prompts or tool hooks. Initialize known trading tools with review permissions. Models submit permission suggestions through tools; code owns persistence.
- All ffa workspaces share one user-scoped Python venv. Ready workspace startup automatically prepares locked dependencies and activates the venv for this Pi process; errors are reported without changing system Python. Python uses native Bash and the project working directory. Setup does not execute research or create run records. Do not add a calculation tool, unified library wrapper, or implicit market rules. Project builds and tests use their declared environment.
- Do not claim host isolation for Bash, Python, or extensions.
- Do not add file hash verification in code, tests, builds, or checks.

## Style

Use TypeScript ESM, two-space indentation, double quotes, semicolons, and `.js` suffixes in relative imports. Use `import type` for type-only imports. Keep strict compiler checks.

Use camelCase for variables and functions, PascalCase for types, and kebab-case for multiword filenames. Keep provider details in their integration.

## Tests

Use `node:test` and `node:assert/strict`. Import compiled modules from dist. Test concrete correctness risks, not coverage counts or implementation structure.

Do not use mocks, stubs, fake models, simulated providers, real trades, or personal credentials. Use actual local files, processes, calculations, and Pi SDK behavior.

Do not test documentation, prompt text, labels, or message wording. Parsing and serialization may verify structured values when they form the logic contract.

Real model and external provider acceptance requires an approved environment. Record remaining gaps; local tests do not prove those behaviors.

## Submission

Use concise `feat:` or `fix:` commit prefixes. Keep changes focused.

Update design and usage docs when behavior changes. Run `npm run check`, `npm test`, and `git diff --check` before submission. Keep credentials, runtime databases, and local configuration out of commits.
