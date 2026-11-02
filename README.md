# 1harness

A programmable control surface for agent harnesses, locally and remotely.

The intended product combines a terminal agent view, persistent local and remote
sessions, cross-harness orchestration over MCP, and a programmable interface for
custom clients and shared tools.

Implemented so far: one terminal UI for Claude Code, Codex, OpenCode, and agents
that speak the Agent Client Protocol (such as fx), with shared MCP servers and a
layered extension system. Threads run in a background server that keeps them
working while no terminal is open, and keeps them across restarts. A public
programming interface is not implemented yet.

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
1harness -r 3f9c2a1b              # reopen a 1harness thread, from any folder
1harness -r <thread-id>           # resume a harness's own thread or session
1harness -p "summarize README.md" # one turn without the UI
```

Every harness gets the same chat: streamed replies and reasoning, commands with
their output, diffs, tool calls, todo lists, proposed plans, and agents.
In terminals that speak the Kitty graphics protocol (Rex, kitty, Ghostty),
replies draw Mermaid diagrams, typeset display math (`$$…$$`, `\[…\]`, and
` ```math ` blocks), and show images linked on a line of their own; elsewhere
they show as text. Inline math (`$…$`, `\(…\)`) reads as Unicode text, such as
`x² + yᵢ ≤ √π`. Clicking a picture shows it on the whole screen.
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
1harness owns the commands, the same on every harness: `/new`, `/resume`,
`/rename`, `/fork`, `/close`, `/compact`, and `/unqueue` for threads; `/model`,
`/effort`, and `/harness`; `/mode` and `/plan`; `/mcp` and `/extensions`; and
`/help`, `/status`, `/copy`, `/connect`, and `/quit`. From a harness come only
your skills and your own commands, such as a `/sol-loop` skill, never its
built-in ones. Typing after a command offers its arguments, such as
`/mcp login <server>`. `@` completes files and folders with
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
its thread's ID, and a retried `requestId` returns the same task. Delegation stops at three levels deep, and, within one tree of threads, at
eight threads working and sixteen with a harness running; `task_cancel` on a
finished task closes its thread.

A thread an agent starts appears as a row in its parent's conversation: a dot
for its status, what it is doing, and the harness, model, and effort it runs
on; on Claude Code and Codex the row takes the place of the call that started
it. Its approvals and questions wait in its own
thread: a line above the composer says an agent needs you, ctrl+o opens it, and
alt+↑ goes back to the thread that started it. `/resume` (or ctrl+t) switches
between threads. Esc stops the thread on screen and
every agent under it; what they would have reported is not sent back, but
messages you queued still run.
`/close` ends a thread along with the threads it started. A thread you leave
stays open, working or idle, and `/resume` switches back to it; one you leave
with nothing in it is dropped. A thread whose harness sits idle for 30 minutes,
or ends on its own, keeps its place: the harness is closed to free it, and your
next message resumes the harness's own thread, or starts a new one with a
handoff when it cannot. A harness running background work, such as Claude
Code's background agents, stays open.

### The server

Threads run in the 1harness server, not in the terminal. The first `1harness`
starts one in the background, listening on
`$XDG_RUNTIME_DIR/1harness/server.sock` (only you can open it), and every later
one connects to it, so several terminals share their threads, each showing the
ones it opens. Quitting a terminal leaves its threads working: a turn keeps
running, an agent keeps going, and reopening the thread shows what it did. A
server started this way stops about ten seconds after its last terminal quits
and nothing is working; `1harness server start` starts one that stays.
`1harness server status`, `logs`, and `stop` look after it. When the terminal
loses the server, it says so and reconnects, catching up on what it missed. A
server that dies is started again by the terminals using it, with its threads
back where they were; one you stop with `1harness server stop` stays stopped
until the next `1harness` starts it.

Each thread gets its folder's extensions: the user's, plus the folder's own once
trusted. Extensions named with `-x` load for the threads that terminal opens.
An agent sees and acts on only its own tree of threads, from the user's thread
at its root; another terminal's threads are not its own, and the limits on
delegation count per tree.

`ONEHARNESS_AUTOSTART=0` runs everything in the terminal's own process, with no
server, as `--print` always does.

To keep a server running from login, `1harness server install` sets up a user
service: systemd units on Linux, `1harness.service` with a `1harness.socket`
that starts it on the first connection, and a LaunchAgent on macOS. Services
start with almost no environment, so it writes the `PATH` of the shell you run
it in, where your harnesses are, to `~/.config/1harness/server.env`; run it again
after installing a harness somewhere new. On Linux, `loginctl enable-linger`
keeps the server running while you are logged out. `--print` shows the units
instead, and `server uninstall` removes them.

With Nix, `nix run github:phongndo/1harness` runs it, and the flake exports
`nixosModules.default`, `darwinModules.default`, and `homeManagerModules.default`
for `services.oneharness`:

```nix
services.oneharness = {
  enable = true;
  path = [ pkgs.codex ];  # harnesses the server should find
};
```

The NixOS and home-manager modules start the server from its socket; the
nix-darwin one runs a LaunchAgent. Each reads `~/.config/1harness/server.env`
too, for harnesses installed outside Nix.

### From another machine

A server can listen on more than its socket. On the machine with your folders
and harness logins:

```sh
1harness server run --extra-listen tailnet://:7330   # or put it in the service's arguments
```

`tailnet://:PORT` listens on the machine's Tailscale addresses and asks
tailscaled who each caller is; only the machine's owner gets in, unless
`--tailnet-allow-identified` lets in anyone tailscaled identifies.
`tailnet-serve:///path/to/socket` makes a socket for `tailscale serve` to proxy
to, which names the caller. A plain `tcp://HOST:PORT` lets in anyone who can
reach it, so it needs `--allow-anonymous`.

From another machine, `1harness -S host:7330` connects to it, or name it once
with `1harness hosts add z z.example.ts.net:7330` and use `-S z`, or set
`ONEHARNESS_SERVER`. Threads, files, and logins stay on the server's machine;
a thread starts in its home folder unless `-C` names one there. `1harness
threads`, `watch`, and `whoami` take `-S` too, and `1harness hosts check` says
which servers answer and who each takes you to be.

### Threads that last

1harness keeps every thread in `~/.local/state/1harness/1harness.db` (SQLite,
under `$XDG_STATE_HOME`): what was said, each run, the harnesses it ran on, and
your always-allow choices. Each thread's ID is a random UUID; lists show its
first eight characters, such as `3f9c2a1b`, and those, or any part of the ID
from its start that only one thread's begins with, are enough to name it.
Threads from before UUIDs keep IDs such as `t42`. When
1harness stops, its threads stop with their harnesses but keep their place; the
next 1harness brings them back, and `1harness -r 3f9c2a1b` or `/resume` opens one,
along with your harness's own earlier threads under a second tab. Nothing
starts by itself after a restart. A turn that was running when 1harness
stopped is marked interrupted, since how it ended is unknown, and is never sent
again. Messages that were still queued come back held: they run, in order,
once you send that thread something. A task an agent delegated reports nothing
after a restart; the agent can ask with `task_status`. Text still streaming when
1harness crashes is kept up to the last write, a moment before.

`/resume` (or ctrl+t) lists your threads by what each is doing, with the
harness, model, and effort it runs on, newest first. It lists your own
threads, not the agents they started. `/lineage` lists those the same way:
the agents under the thread on screen, kept up to date as they work. Enter
goes into an agent, ← back out to the thread that started it, and the list
stays open over both until esc. A thread is named for what it
does by its harness, Claude Code or Codex, after its first turns; until then,
and on harnesses that name none, by its first message. `/resume 3f9c2a1b` opens a
thread by its ID, or a harness's own session by its ID, and `/resume <words>`
searches what every thread said. `/rename` names a thread, and a name you give
it stays. `/fork [turn]` starts a new thread on the same harness and
folder from this one's turns, all of them or up to a turn; its first message
carries them, and its agent can read the rest with `thread_read`. Outside the
terminal, `1harness threads` lists this folder's threads (`--all` for every
folder, words to search, `--json` for scripts), and `1harness threads show 3f9c2a1b`
prints one. Closed threads are kept until you forget them; set
`retainClosedDays` in `settings.json` to delete ones closed longer ago when the
server starts. Pinned ones are always kept.

Only one 1harness keeps threads at a time, normally the server. A second one
started with `ONEHARNESS_AUTOSTART=0` meanwhile says so and keeps none of its
own, leaving the first one's alone.

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
`ONEHARNESS_PROGRAM_STATUS=1` or `0` to decide yourself. Each terminal reports
the threads it opened, and the agents they started.

`1harness watch` reports every thread on the server the same way, and lists
them, for when no 1harness terminal is open. In Rex, keep one in a background
tab: `rex run --label 1harness --focus=false -- 1harness watch`. A run you
finished looking at in any terminal counts as seen there too.

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
- `src/host` owns every thread and the orchestrator tools agents use to start
  and manage other threads. Clients reach it only through the requests and
  event feed in `src/protocol.ts`, the same in-process as over a socket; each
  thread's transcript is a log that a client replays to show it.
- `src/client` is a client's side of that: a connection, in-process or over the
  server's socket, and every thread's state kept current from the feed.
- `src/server` serves the host over HTTP/1.1 on a Unix socket, and on tailnet
  listeners: `GET /v1/hello`, `POST /v1/rpc`, and `GET /v1/events?after=<seq>`,
  the feed as lines of JSON. It starts, stops when idle, and hands over to the
  next server.
- `src/store` keeps threads in SQLite.
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
