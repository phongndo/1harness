# 1harness

A programmable control surface for agent harnesses, locally and remotely.

The intended product combines a terminal agent view, persistent local and remote
sessions, cross-harness orchestration over MCP, and a programmable interface for
custom clients and shared tools.

Implemented so far: one terminal UI for Claude Code, Codex, OpenCode, and agents
that speak the Agent Client Protocol (such as fx), with shared MCP servers and a layered
extension system. It runs in a single process on the local
machine. The persistent host, remote connections, and a public programming
interface are not implemented yet.

## Use

`1harness` drives the harnesses you already have installed, with your own logins,
settings, MCP servers, hooks, and project instructions. Codex needs `codex` on
`PATH`. Claude uses `claude` on `PATH`, or the copy the Claude Agent SDK bundles.
OpenCode needs OpenCode 2's `opencode` on `PATH`; each thread runs its own
`opencode serve`, and models go by `provider/model`, such as `openai/gpt-6.1-terra`.
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

Every harness gets the same chat: streamed replies and reasoning, commands with
their output, diffs, tool calls, todo lists, proposed plans, and agents.
Approvals and questions offer each harness's own choices. While a turn runs, Enter
adds a message to it and Tab queues one as the next turn. Esc stops the turn and
the agents under it. Page Up, Page Down, and the mouse wheel scroll the
conversation; most terminals select text with Shift held while dragging.

Slash commands switch the model, effort, permission mode, plan mode, and
harness, and start, resume, or compact threads. Every harness has the same four
permission modes and carries each out with its own sandbox and approval rules,
so details differ: in `auto-edit`, Codex runs commands inside its workspace
sandbox without asking, where Claude Code asks first. OpenCode carries modes out
with its permission rules and has no `auto`, so `auto` runs as `auto-edit` there.

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

`/harness <name>` moves the thread on screen to another harness without
starting over. The thread keeps its ID, queue, agents, approvals you chose to
always allow, and permission and plan modes. The new harness's next message
carries a handoff of the turns it has not seen, marked as history rather than
requests: each turn's message, reply, commands with their exit codes (not their
output), and changed files. When they do not all fit, the original request and
the newest turns stay, and the handoff names the `thread_read` call for the
ones left out. It never carries reasoning.

Going back to a harness the thread used before resumes that harness's own
thread, so it hears only what happened since; the notice says how much context
that thread holds and when it was last used, since its next message pays for
all of it again. `/harness <name> fresh` starts a new thread there instead, and
on the current harness starts it over with a handoff. A thread moves only
between turns, and not while its harness runs background work that closing it
would stop, such as Claude Code's background agents. A harness that cannot
start, cannot resume its thread, or cannot run as narrowly as the thread leaves
the thread where it was or starts it a new thread, and says which.
`/new <name>` starts a fresh thread on another harness.

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
`thread_read` (the latest runs or a range, in pages that fit), `thread_send`,
`thread_wait`, and `thread_interrupt` work on any thread; `orchestrator_capabilities` lists the harnesses and limits. A task never
gets a broader permission mode than the thread that started it, or leaves plan
mode, and a harness that cannot run it that narrowly is refused. A task goes by
its thread's ID, such as `t2`, and a retried `requestId` returns the same task. Delegation stops at three levels deep, eight
threads working, and sixteen open; `task_cancel` on a finished task closes its
thread.

A thread an agent starts appears as a row in its parent's conversation, with its
status, a timer, and what it found; on Claude Code and Codex the row takes the
place of the call that started it. Its approvals and questions wait in its own
thread: a line above the composer says an agent needs you, ctrl+o opens it, and
alt+↑ goes back to the thread that started it. `/threads` (or ctrl+t) switches
between threads, shown as a tree. Esc and `/stop` stop the thread on screen and
every agent under it; what they would have reported is not sent back, but
messages you queued still run.
`/close` ends a thread along with the threads it started. A thread you leave
keeps running in the background while it or a thread it started has work, and
closes once they are done.

### Status in your terminal

In a terminal that supports the
[Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)
(OSC 7501), such as [Rex](https://www.superlogical.com/rex), 1harness reports
what each thread is doing: working, waiting on you (an approval or a question,
with what it asks), done with a reply you have not seen, or failed. Each thread
is its own record, nested under the thread that started it, so Rex's session
picker and tab headers show agents that need you or have finished. A reply that
finishes while you are looking counts as seen; 1harness knows you are looking
from the terminal's focus reports and from your typing. An agent's thread
reports its work and requests, not its results, which go to that agent.
1harness asks the terminal whether it supports the protocol; set
`ONEHARNESS_PROGRAM_STATUS=1` or `0` to decide yourself.

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
- `src/drivers/opencode` runs `opencode serve` and uses its HTTP API and event
  stream.
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
