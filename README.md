# 1harness

A programmable control surface for agent harnesses, locally and remotely.

The intended product combines a terminal agent view, persistent local and remote
sessions, cross-harness orchestration over MCP, and a programmable interface for
custom clients and shared tools.

Implemented so far: one terminal UI for Claude Code, Codex, and agents that speak
the Agent Client Protocol (such as fx), with shared MCP servers and a layered
extension system. It runs in a single process on the local
machine. The persistent host, remote connections, and a public programming
interface are not implemented yet.

## Use

`1harness` drives the harnesses you already have installed, with your own logins,
settings, MCP servers, hooks, and project instructions. Codex needs `codex` on
`PATH`. Claude uses `claude` on `PATH`, or the copy the Claude Agent SDK bundles.
fx runs through `fx acp`. Any other ACP agent can be added in
`~/.config/1harness/agents.json`:
`{ "agents": { "gemini": { "label": "Gemini CLI", "command": "gemini", "args": ["--experimental-acp"] } } }`.
From a checkout, run `pnpm dev` or `node dist/cli.js` after `pnpm build`.

```sh
1harness                          # Claude Code in the current folder
1harness -H codex -m <model>      # Codex with a chosen model
1harness --mode auto-edit --plan  # start in plan mode, edits auto-accepted
1harness -r <thread-id>           # resume a native thread or session
1harness -p "summarize README.md" # one turn without the UI
```

Both harnesses get the same chat: streamed replies and reasoning, commands with
their output, diffs, tool calls, todo lists, proposed plans, and subagents.
Approvals and questions offer each harness's own choices. While a turn runs, Enter
adds a message to it and Tab queues one as the next turn. Esc interrupts. Page Up,
Page Down, and the mouse wheel scroll the conversation; most terminals select text
with Shift held while dragging.

Slash commands switch the model, effort, permission mode, plan mode, and
harness, and start, resume, or compact threads. Every harness has the same four
permission modes and carries each out with its own sandbox and approval rules,
so details differ: in `auto-edit`, Codex runs commands inside its workspace
sandbox without asking, where Claude Code asks first.

- `supervised`: read freely; ask before edits and commands;
- `auto-edit`: edit files without asking; ask before riskier actions;
- `auto`: a safety check decides what needs asking;
- `full-access`: never ask.

Threads start in `full-access`. To start somewhere narrower, set `mode` in
`~/.config/1harness/settings.json`, such as `{ "mode": "auto" }`, or pass
`--mode` for one run; a `settings.json` that cannot be read starts threads in
`supervised` until it is fixed. A harness that lacks the mode, or whose own
settings rule it out (Claude Code's settings, or a sandbox Codex will not grant),
runs the broadest mode it has below it and says so; one with nothing that narrow
does not start.

Approvals, plan prompts, and notices use the same words whichever harness asks.
The harness's own commands and skills appear beside 1harness's, less those that
only drive its own terminal. Typing after a command offers its
arguments, such as `/mcp login <server>`. `@` completes files and folders with
[fff](https://github.com/dmtrKovalenko/fff); a mentioned image is attached.
`/help` lists everything.

### MCP servers

`/mcp` shows every server a session has, wherever the harness found it, and can
show, sign in to, reconnect, enable, or disable one where the harness allows.
Servers in `~/.config/1harness/mcp.json` (and a trusted project's
`.1harness/mcp.json`) are added to every session on every harness, without
touching the harnesses' own config. Both use the common
`{ "mcpServers": { "name": { "command": …, "args": […] } | { "url": … } } }` shape;
`${VAR}` in a value is read from the environment.

### Threads and orchestration

1harness runs many threads at once, on any mix of harnesses. Agents start and
manage them through tools on the `1harness` MCP server every session has:
`delegate_task` hands a task to a new thread on any available harness and
waits for its result, or returns at once and sends the result back as a message
when it finishes; `task_status` and `task_cancel` follow it up; `thread_list`,
`thread_read`, `thread_send`, `thread_wait`, and `thread_interrupt` work on any
thread; `orchestrator_capabilities` lists the harnesses and limits. A task never
gets a broader permission mode than the thread that started it, or leaves plan
mode, and a harness that cannot run it that narrowly is refused. A retried
`requestId` returns the same task. Delegation stops at three levels deep, eight
threads working, and sixteen open; `task_cancel` on a finished task closes its
thread.

A thread an agent starts appears as a row in its parent's conversation. Its
approvals and questions come to you wherever you are, labelled with the thread.
`/threads` (or ctrl+t) switches between threads, and `/close` ends one along
with the threads it started. A thread you leave keeps running in the background
while it or a thread it started has work, and closes once they are done.

### Extensions

An extension is a TypeScript or JavaScript module whose default export receives
the API in `src/extensions/api.ts`, imported as `1harness/extension` wherever the
extension lives. Through it, one extension works on every harness:

- commands: `/name` with argument completion, in whichever client runs;
- session handlers: every thread's events, messages before they are sent, and
  approvals before the user sees them;
- tool checks: every tool call before it runs, in any permission mode, through
  Claude Code's hooks and a hook Codex asks you to trust once;
- tools: functions the agent can call, served to each harness as the `1harness`
  MCP server;
- harnesses: an ACP agent in one call, or a full driver.

When you choose to always allow an action, the same command, files, or tool are
approved again without asking for the rest of the thread, on every harness.

Extensions load from `~/.config/1harness/extensions` and, once you run
`/extensions trust`, from the project's `.1harness/extensions`; `-x <path>` loads
one more. `/extensions reload` loads them again after edits. `examples/extensions` has an approval policy and a notebook that every
harness's agent shares.

## Layout

- `src/core` holds the harness-neutral events, the session interface every driver
  implements, and `Thread`, which owns busy state, the follow-up queue, steering,
  and the hooks that let code see messages and requests first.
- `src/drivers` registers each harness; nothing outside a driver names one. The
  ACP driver serves fx and any other ACP agent.
- `src/drivers/codex` speaks the `codex app-server` JSON-RPC protocol over stdio.
- `src/drivers/claude` uses the Claude Agent SDK in streaming-input mode.
- `src/commands` holds the command registry and 1harness's own commands, which
  any client can run.
- `src/extensions` loads extensions, connects them to threads, and serves their
  tools over MCP.
- `src/host` owns every live thread and the orchestrator tools agents use to
  start and manage other threads; clients reach threads only through it.
- `src/tui` is a full-screen terminal UI on the alternate screen, styled after
  [fx](https://github.com/vercel-labs/fx). Each block's rows are cached by width,
  and each frame rewrites only the rows that changed.

Clients read capabilities, never the harness kind, so adding a harness means
adding a driver.

## Development

The locked Nix flake provides Node.js 24, pnpm, and Git on Linux and macOS, for
x86-64 and ARM64. Enter the environment and install the locked dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check   # type check, lint, format check, and tests
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
- [Remote connection and control](docs/research/remote.md)

These documents distinguish existing upstream behavior from proposed 1harness behavior. They inform implementation without committing the project to
an upstream agent runtime.
