# 1harness

One terminal UI for Claude Code, Codex, OpenCode, and Agent Client Protocol
agents such as fx. Threads run in a background server that outlives the
terminal, can be reached from other machines over a tailnet, and can delegate
work to each other across harnesses.

## Use

1harness drives the harnesses you already have installed, with their own
logins and settings: `claude`, `codex`, `opencode`, or `fx` on `PATH`.

```sh
1harness                  # Claude Code in the current folder
1harness -H codex         # another harness
1harness --help           # every option, subcommand, and environment variable
```

Inside the UI, `/help` lists every command.

| Path                                  | What it holds                                     |
| ------------------------------------- | ------------------------------------------------- |
| `~/.config/1harness/settings.json`    | defaults, such as `{ "mode": "auto" }`            |
| `~/.config/1harness/mcp.json`         | MCP servers added to every harness (`mcpServers`) |
| `~/.config/1harness/agents.json`      | extra ACP agents                                  |
| `~/.config/1harness/extensions/`      | extensions; a trusted project adds `.1harness/`   |
| `~/.local/state/1harness/1harness.db` | threads, kept across restarts                     |

Extensions program against [`src/extensions/api.ts`](src/extensions/api.ts);
[`examples/extensions`](examples/extensions) has two to start from.

With Nix, `nix run github:phongndo/1harness`, or run the server as a service
through the flake's `nixosModules`, `darwinModules`, or `homeManagerModules`
(see [`nix/modules/options.nix`](nix/modules/options.nix)).

## Development

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check   # type check, lint, format check, tests
pnpm dev     # run from source
```
