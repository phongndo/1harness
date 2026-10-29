# API and runtime research

Research date: **2026-10-28**. This document records findings from released first-party documentation and source, followed by proposed design direction for 1harness. It does not define an implemented API.

## Releases examined

| Project                                                                                   | Released version | Release date | Relevant stability boundary                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------- | ------------ | --------------------------------------------------------------------------------------------- |
| [fx / libfx](https://github.com/vercel-labs/fx/releases/tag/v0.0.15)                      | `0.0.15`         | 2026-10-27   | Pre-1.0; the release includes breaking API and storage changes.                               |
| [Pi](https://github.com/earendil-works/pi/releases/tag/v1.4.0)                            | `1.4.0`          | 2026-10-21   | Released coding-agent SDK and RPC client; published packages use the `@earendil-works` scope. |
| [Pi Durable](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md) | `1.4.0`          | 2026-10-21   | Explicitly experimental: APIs may change without notice despite the monorepo release version. |

The npm releases of `libfx`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-durable` matched these versions when checked. Pi packages require Node.js 22.19 or newer. libfx supports Node.js 20 or newer, with additional native-addon or WebAssembly runtime requirements.

## Findings

### libfx: configuration, conversations, and execution

The [released SDK](https://github.com/vercel-labs/fx/blob/v0.0.15/sdk/README.md) separates Agent configuration, Session conversations, and Turn execution. `turn.accepted` confirms stored input; `turn.result` reports completion after the final state is saved. These are distinct acknowledgments.

Busy prompts queue. Explicit steering can shorten a streaming reply, but waits for a running tool. Stable `messageId` values deduplicate retries. Session streams carry cursors for reconnecting clients; disconnecting an observer does not stop work. Cancellation is explicit.

Tools declare `idempotent` and `writes`, and receive stable execution IDs for replay-safe external effects. The lower-level persistence contract supports expected-cursor fencing and durability barriers. Application authentication and tool authorization remain host responsibilities.

### Pi: a programmable session with a subprocess boundary

The [released SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md) exposes session creation, prompting, steering, follow-ups, cancellation, idle waiting, event subscriptions, and disposal. Models, tools, resources, settings, and session storage can be supplied by the host. Persistence uses an entry tree with branching and compaction.

A prompt submitted while streaming must explicitly choose steering or follow-up behavior. `agent_end` can precede automatic recovery or queued work; `agent_settled` indicates that automatic continuation has finished. Replacing an active session requires rebinding subscriptions.

[RPC mode](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md) provides a long-lived subprocess protocol with typed `RpcClient` support, correlated command acknowledgments, streamed events, and extension UI records. Successful prompt acknowledgment does not mean execution completed. Protocol stdout and diagnostic stderr are separate.

SDK sessions explicitly install and bind MCP, tool-search, and codemode extensions; they do not inherit every CLI extension automatically.

### Pi Durable: committed state and ownership

[Pi Durable](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md) commits state before exposing it. Submissions have durable request IDs; busy inputs can follow up, steer, or reject. Cancelling a wait does not cancel work.

UIs attach to committed snapshots and watches. Slow consumers receive replacement snapshots instead of an unbounded backlog. Tools replay interrupted execution only when explicitly marked safe. Task ownership controls cancellation propagation; background tasks form an explicit boundary.

Storage includes SQLite, JSONL, IndexedDB, and Cloudflare Durable Objects. A storage has one owning process; the package provides no cross-process locking. Its experimental API and event projection need isolation if adopted.

## Proposed direction for 1harness

These are design recommendations, not public interface commitments:

1. **Keep the core independent of an agent runtime.** fx, Pi, and Pi Durable run their own model/tool loops. Controlling installed harnesses requires separate drivers that preserve native thread/session handles and advertise supported capabilities.
2. **Separate admission, execution, and observation.** Acknowledge durable command acceptance independently from eventual completion. Track command IDs, session IDs, run IDs, and event positions explicitly. Retried admissions should not create duplicate work.
3. **Specify queue, steer, and cancel behavior.** Distinguish a follow-up from steering active work, withdrawing queued input, cancelling a run, and stopping observation. Drivers must report unsupported behavior or documented fallbacks rather than silently treating these operations as equivalent.
4. **Make reconnection a client capability.** Reattaching should provide a current snapshot and a supported event continuation strategy. Disconnecting a UI should leave server-owned work running. Define completion independently of a provider's intermediate turn-end event.
5. **Own the shared MCP surface.** Expose orchestration and shared tools through a 1harness-owned service, with each driver configuring or injecting access through its supported mechanism. Native extension objects from Pi or libfx do not automatically become tools inside other harnesses. Tool execution, credentials, authorization, and lifecycle need clear owners.
6. **Preserve uncertainty after interruption.** Persisted orchestration state does not prove an external harness or side effect can be replayed safely. Retain provider handles, reconcile native state, and represent ambiguous outcomes. Automatic replay requires an explicit safety contract.

## Adoption boundary

Use these projects as API and lifecycle references while the repository is a scaffold. Do not add an agent runtime solely to obtain its type names or session abstraction.

A later Pi driver can use its public RPC boundary; an fx driver can evaluate ACP. In-process SDK integration belongs inside the corresponding driver. A terminal client can evaluate `@earendil-works/pi-tui` independently of Pi's agent loop. Adopting libfx or Pi Durable would be a separate decision to include their own runtime, storage semantics, and compatibility obligations.

Findings are based on documentation and source inspection. No runtime behavior, recovery guarantee, cross-harness parity, or remote-session integration was exercised here.
