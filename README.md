# 1harness

A programmable control surface for agent harnesses, locally and remotely.

The intended product combines a terminal agent view, persistent local and remote
sessions, cross-harness orchestration over MCP, and a programmable interface for
custom clients and shared tools.

This repository currently contains the development scaffold and design research.
The `1harness` entry point provides help and version output. Harness execution and
the public programming interface are not implemented yet.

## Development

The locked Nix flake provides Node.js 24, pnpm, and Git on Linux and macOS, for
x86-64 and ARM64. Enter the environment and install the locked dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
pnpm build
node dist/cli.js --help
```

For individual commands from outside the shell:

```sh
nix develop -c pnpm dev --help
nix develop -c pnpm format
nix fmt -- flake.nix
```

TSRS performs both type checking and JavaScript emission; Oxlint checks code and
Oxfmt formats it. Versions are pinned in `package.json` and `pnpm-lock.yaml`.
Nix inputs are pinned in `flake.lock`.

TSRS is pinned to the latest non-prerelease project release checked on
2026-10-28: [v0.20.1](https://github.com/oxc-project/tsrs/releases/tag/v0.20.1).
Its npm version, `0.20.1-ts7.1.0-beta`, identifies the TypeScript beta it targets;
this does not make TypeScript 7.1 stable.

## Design research

- [Interactive architecture and implementation plan](docs/plan.html)
- [Programming interface: FX, Pi, and Pi Durable](docs/research/api.md)
- [ScriptC runtime and packaging evaluation](docs/research/scriptc.md)

These documents distinguish existing upstream behavior from proposed 1harness behavior. They inform implementation without committing the project to
an upstream agent runtime.
