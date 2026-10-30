# Remote connection and control research

Research date: **2026-10-29**. This document records how T3 Code makes remote use feel local, with Zed and Tailscale as points of comparison, followed by proposed direction for 1harness. It does not define an implemented interface.

## Sources examined

| Project                                                                                      | Version                                           | Notes                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/fa4e4677c0ecc437aece2dcea39f76ef31414152) | `main` at `fa4e4677` (server `0.1.5`), 2026-10-29 | No stable release tag; nightlies only. Internal and user docs plus `packages/ssh`, `packages/client-runtime`, and the server. |
| [Zed remote development](https://zed.dev/docs/remote-development)                            | Documentation as published on 2026-10-29          | Documentation only; source not inspected.                                                                                     |
| [Tailscale Serve](https://tailscale.com/kb/1312/serve)                                       | Documentation as published on 2026-10-29          | Identity headers and HTTPS provisioning.                                                                                      |

T3 Code links below are pinned to that commit.

## Findings: T3 Code

### One server per machine; routes are hints

An _environment_ is one running server and the machine, files, credentials, and state it owns. Every remote mode (direct LAN, Tailscale, SSH, T3 Connect) changes only how a client reaches that server; none introduces another execution model. [remote.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/remote.md)

- The environment ID survives restarts and address changes. A saved environment holds an **ordered list of routes**; the client connects over the first that works.
- Before sending a credential over a direct route, the client fetches the public descriptor and checks it names the expected environment, so a LAN address now answered by another machine receives no token.
- While connected over a later route, the client re-checks earlier ones (on network change, foregrounding, and every minute) and moves back when one works, with a cooldown so a flaky route cannot bounce the session.
- A connected server reports its LAN and tailnet addresses; the client saves them as **learned routes** that reuse the credential of the route they were learned over. Pairing once through any route is therefore enough to use the LAN later. [remote-access.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/user/remote-access.md#reach-one-machine-several-ways)

### SSH launches as well as forwards

Desktop-managed SSH asks only for a host or SSH alias. T3 Code then starts or reuses a server there and opens the forward. [remote-access.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/user/remote-access.md#desktop-managed-ssh), [tunnel.ts](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts)

- **Install:** a runner script downloads a pinned, self-contained release archive (no Node needed on the host) into `~/.t3/runtime/versions/<version>`, verifies `SHA256SUMS`, holds an install lock, runs `t3 --version` to prove the binary works on that libc and architecture, and only then marks it complete and moves it into place. A source comment notes a cold launch downloads and extracts about 70 MB. [tunnel.ts:55](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts#L55), [tunnel.ts:420-524](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts#L420-L524)
- **Launch or adopt:** a launch script records pid, port, and `managed`/`external` ownership under `~/.t3/ssh-launch/<key>`. It adopts an already running server rather than starting a second, and starts one with `nohup … serve --host 127.0.0.1` only when none answers. [tunnel.ts:526-723](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts#L526-L723)
- **Forward:** `ssh -N -L` with `ExitOnForwardFailure=yes`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, and no control master. Reconnection restores the forward before the application transport. [tunnel.ts:1144-1157](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts#L1144-L1157)
- **Credentials:** the client obtains a pairing token by running `auth pairing create --json` over SSH, so SSH users never pair by hand. Password prompts are bridged with an `SSH_ASKPASS` helper because a GUI has no terminal. [tunnel.ts:725-736](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/tunnel.ts#L725-L736), [auth.ts](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/packages/ssh/src/auth.ts)
- **Cleanup:** disconnecting stops a server only if this launcher started it; a discovered server must survive the client.

### Pairing, sessions, and scopes

[environment-auth.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/environment-auth.md)

- `t3 pair` prints a one-time link and QR code. Exchanging it yields a scoped session (default TTL 30 days); a fresh one-time link is needed per device, not per reconnect. [SessionStore.ts:427](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/server/src/auth/SessionStore.ts#L427)
- Hosted pairing URLs carry the secret in the fragment so it never reaches the hosting origin.
- Long-lived tokens stay out of socket URLs: clients mint short-lived WebSocket tickets (5 minutes) over authenticated HTTP, optionally bound to a DPoP key. [SessionStore.ts:428](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/server/src/auth/SessionStore.ts#L428)
- Every RPC declares a required scope, checked in middleware before any handler. The default grant is full access, because `terminal:operate` or `orchestration:operate` can mint any other scope anyway.

### Tailscale is a route, not an environment type

`t3 serve --tailscale-serve` or `t3 pair --tailscale` maps the server behind Tailscale Serve HTTPS (`https://machine.tailnet.ts.net/`); authentication is still ordinary pairing. [remote-access.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/user/remote-access.md#tailscale-https), [remote.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/remote.md#access-and-process-ownership-are-different)

Tailscale Serve itself injects `Tailscale-User-Login` and `Tailscale-User-Name` into proxied requests, strips client-supplied copies, and omits them for tagged devices and Funnel traffic. It recommends a loopback-only backend so the headers cannot be bypassed. T3 Code does not use these headers. [Tailscale Serve](https://tailscale.com/kb/1312/serve)

### Background service and network exposure

[background-service.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/user/background-service.md)

- `t3 service install|status|restart|uninstall`: a systemd user unit with lingering enabled on Linux, a LaunchAgent on macOS (which stops at logout). Windows is unsupported.
- The service listens on every IPv4 interface but closes connections unless both peer addresses are loopback, private, or tailnet, so a VPS's public address stays closed. The docs state this is not a firewall: proxies that rewrite source addresses look private. [server.ts:312-318](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/server/src/server.ts#L312-L318)
- `service.env` holds overrides; `t3 service protect` adjusts Linux memory and OOM settings so agents filling memory do not take down the server.

### Client connection runtime

One connection owner per environment, shared by web, desktop, and mobile. [connection-runtime.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/connection-runtime.md)

- One retry owner: jittered exponential backoff capped at five minutes, reset only after the connection stays up. Offline and authentication failures wait for a wake signal instead of retrying.
- Wake, network change, and explicit retry **probe** the existing socket; only a failed probe reconnects. Dead-socket deadlines are 3 seconds on loopback/LAN and 15 seconds elsewhere, because DERP-relayed tailnets can be slower than that while healthy.
- A socket opening is not readiness: the session is ready only after the initial server configuration arrives. Transport health and data freshness are reported separately.
- Cached projections stay readable offline but must not imply a live connection or overwrite newer data.
- Subscriptions are scoped so a client viewing one thread does not receive every thread's history. Snapshots carry a sequence cursor; reconnect resumes after it. [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/orchestration-v2/core-graph-and-data-model.md)
- Reconnection never replays mutations automatically; retry and idempotency belong to each operation.
- WebSockets use per-message deflate with context takeover. [server.ts:323-327](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/apps/server/src/server.ts#L323-L327)

### Version skew and updates

[remote.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/remote.md), [server-updates.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/server-updates.md)

- Remote servers outlive client releases, so clients act on advertised capabilities and handle their absence instead of assuming their own version.
- A stable launcher owns the service's runtime. Updates start the target as a trial that must migrate, bind, and park long-running work before the launcher durably commits it; a failed trial restores a snapshot of the SQLite main, WAL, and shared-memory files.
- `t3 update` asks before restarting because a restart interrupts running turns. Recovery resumes only runs with matching durable run, provider-thread, session, and native resume identity, and caps consecutive continuations at three.

### Remote control by agents and scripts

- An environment serves `/mcp` for agents it did not launch (Claude Code, Codex, ChatGPT). Sign-in is OAuth with PKCE; the owner grants read-only or a runtime-mode ceiling, and `/mcp` sessions are rejected on every other route. [outside-agents.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/user/outside-agents.md), [environment-auth.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/environment-auth.md#mcp-clients-are-a-separate-audience)
- On the host, `t3 thread start|send|show|list` uses the same tools without sign-in. `send --wait` exits 1 on failure or stop and 2 when the agent waits for an answer.
- Peer links let one environment's agents operate another's threads, with access fenced by the link's grant. [remote.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/remote.md#peer-links)

### T3 Connect relay

Cloud identity (Clerk) plus one Cloudflare tunnel per linked environment. The relay brokers a one-time, DPoP-bound bootstrap credential; application traffic goes through the tunnel hostname, not the relay. Headless and SSH hosts sign in with an OAuth device-code grant. Supporting it requires a tunnel reaper for idle billed tunnels, a pinned `cloudflared` upgrade path, and per-account caps. [t3-connect.md](https://github.com/pingdotgg/t3code/blob/fa4e4677c0ecc437aece2dcea39f76ef31414152/docs/internals/t3-connect.md)

## Findings: Zed over SSH

[Zed remote development](https://zed.dev/docs/remote-development) uses the local `ssh` and `~/.ssh/config`, prompts for host keys and passwords in its UI, and creates one SSH control master per project that multiplexes its protocol, terminals, and tasks. The remote binary lives in `~/.zed_server` and must match the client version exactly; it is downloaded on the host by default or uploaded over SSH when `upload_binary_over_ssh` is set. Each connection runs the server in proxy mode, which "will start the daemon if it is not running, and reconnect to it if it is." The documentation does not state whether the protocol runs over SSH stdio or a forwarded port.

## Proposed direction for 1harness

These are recommendations, not interface commitments. They refine section 07 of the [plan](../plan.html).

1. **Keep T3 Code's ownership model.** One host per machine and user, a stable host ID, and routes as reachability hints verified before credentials are sent.
2. **Make SSH the first remote path, without a listening port.** `1harness` on the Mac runs `ssh <host> 1harness proxy`; the proxy starts the host if needed and bridges stdio to the host's local Unix socket. SSH then supplies authentication, so no pairing token, TCP listener, or port picker is needed. Ownership follows T3 Code: a host started this way outlives the SSH session. A terminal client can let `ssh` prompt on the TTY before the UI starts, so the askpass bridge is unnecessary. This follows Zed's proxy-mode pattern; whether Zed itself uses stdio is unverified.
3. **Negotiate protocol and capabilities at connect.** Exchange a protocol version range and capability set before any session traffic. Offer an exact-version host install as a convenience, not as the compatibility mechanism.
4. **Install like T3 Code, adjusted for Nix.** Prefer a 1harness already on the host's `PATH` (for Nix hosts, from the user's configuration). Otherwise install a pinned, checksummed artifact with a lock, a "does it run here" check, and an atomic move. A dynamically linked generic binary may not run on NixOS without `nix-ld`, which T3 Code's run check exists to catch. Artifact size and form depend on the host runtime decision.
5. **Add HTTPS routes only when a non-SSH client exists.** For a phone or browser, put the host behind Tailscale Serve with a loopback-only listener. Whether to accept Tailscale identity headers instead of pairing (and how tagged devices are handled) needs a decision; otherwise use T3 Code-style one-time pairing, scoped sessions, and short-lived socket tickets.
6. **Copy the client supervisor, not its UI.** One retry owner per host, jittered capped backoff, probe-before-reconnect, readiness after initial state, freshness separate from transport, and snapshot-plus-cursor resume. Mutations retry only through request IDs, as in the [API research](./api.md).
7. **Render locally; send only events.** A local client keeps typing, scrolling, search, and clipboard at local latency, and the wire carries scoped subscriptions and deltas. This is the advantage over `ssh host -t tmux attach`, which already gives durable remote sessions and is the baseline 1harness must beat.
8. **Install the service declaratively where possible.** Provide `1harness service install` with systemd user units and lingering, plus launchd. For the user's machines, a nix-darwin and NixOS module in `~/nix-config` fits better; NixOS lingering can be declared in configuration.
9. **Ship the host-local scripting CLI early.** `1harness run|send|show --wait` with distinct exit codes is cheap once the host exists, and the orchestration MCP (plan phase 04) can reuse the same service methods.
10. **Defer a relay.** T3 Connect's value is reaching hosts without a VPN, at the cost of an identity provider, billed tunnels, a reaper, and connector upgrades. SSH and Tailscale cover personal Mac-to-Linux use.

## Limitations

- T3 Code was read from `main`, not a stable release; behavior can change before its next release. No T3 Code component was run, and no reconnect, update, or recovery behavior was exercised.
- Zed and Tailscale findings come from documentation only. The Zed transport detail and the NixOS `nix-ld` behavior for T3 Code's archive were not tested.
- The proposals have not been prototyped. The SSH stdio proxy in particular needs a test of disconnect detection, multiple concurrent clients, and behavior when the host restarts mid-session.
