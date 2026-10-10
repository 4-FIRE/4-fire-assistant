# Repository Guidelines

## Project Structure & Module Organization

This repository implements a standalone terminal trading assistant with persistent sessions and controlled trade execution.

- `src/domain/`: execution, workspace, and shared domain types.
- `src/application/`: orchestration, experts, reports, and service ports.
- `src/infrastructure/`: storage, configuration, models, and MCP integrations.
- `src/interfaces/`: terminal interaction, authentication, and approval; `src/main.ts` is the entry point.
- `tests/`: JavaScript test suites, fixtures, and subprocess helpers.
- `resources/`: packaged prompts, protocols, and formula references.
- `docs/`: current architecture and configuration.
- `dist/`: generated JavaScript and declarations. Do not edit generated files.

## Build, Test, and Development Commands

Use Linux and Node.js 22.19 or later. Computation uses a shared Python 3.11+ environment.

- `npm ci --ignore-scripts`: install dependencies from `npm-shrinkwrap.json`.
- `npm run check`: check TypeScript without emitting files.
- `npm run build`: compile `src/` into `dist/`.
- `npm test`: build and run all tests serially.
- `npm start`: run the assistant in the current workspace after building.
- `npm pack`: build and create the distribution archive.

## Development Principles

Apply these principles to every design and code change:

- Use the simplest solution that meets the current requirements. Do not assume requirements that have not been established.
- Add modules, abstractions, dependencies, or configuration only when the current task requires them. Reuse existing structures when they fit.
- Keep each module focused on one responsibility. Keep related logic together and minimize coupling between modules.
- Keep dependencies one-way across architectural layers. Do not introduce circular dependencies. Keep domain logic independent of infrastructure and interfaces.
- Support extension and replacement through clear boundaries where current requirements need them. Keep service-specific details inside their integrations.
- Do not build speculative extension points or general frameworks. Extensibility and pluggability must serve concrete needs without unnecessary complexity.
- Do not add file hash verification in application code, tests, build scripts, or development checks.

## Coding Style & Naming Conventions

Follow existing TypeScript ESM conventions: two-space indentation, double quotes, semicolons, and `.js` suffixes in relative imports. Use `import type` for type-only imports. Keep strict compiler checks enabled.

Use camelCase for functions and variables, PascalCase for types and classes, and kebab-case for multiword filenames. Keep service-specific contracts in infrastructure integrations. No formatter or linter is configured; use `npm run check` and match nearby code.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name suites `tests/*.test.mjs`; import compiled modules from `dist/`. After building, run individual suites with `node --test tests/config.test.mjs`.

Write only necessary unit tests for code logic. Each test must address a concrete correctness risk or prevent a known logic regression. Do not add tests merely to increase coverage or mirror the implementation.

Do not write mock-based tests or use stubs, fake models, or simulated services. Test real logic with explicit inputs and observable results. Never use real trades or personal credentials for tests.

Do not write tests that verify text content, such as documentation, prompts, labels, or message wording. Test decisions, calculations, state changes, and error handling when needed. Parsing and serialization tests may verify structured values when these are part of the logic contract.

## Commit & Pull Request Guidelines

Follow existing commit prefixes such as `feat:` and `fix:` with concise, imperative descriptions. Keep commits focused.

Describe the problem, resulting behavior, and validation in each pull request. Link relevant issues when available. Update configuration or design documentation when behavior changes. Run `npm run check`, `npm test`, and `git diff --check` before submission. Keep credentials, runtime databases, and local configuration out of commits.
