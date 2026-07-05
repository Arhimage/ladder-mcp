# Ladder_mcp

[![npm](https://img.shields.io/npm/v/ladder-mcp.svg)](https://www.npmjs.com/package/ladder-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2011-0078D4.svg)](#requirements)

Windows-first [MCP](https://modelcontextprotocol.io/) bridge for the
[Kimi CLI](https://github.com/MoonshotAI/kimi-cli) (v24). It exposes Kimi Code as MCP tools so a
client like Claude Code can run codebase analysis, native sessions, API
queries, ACP chat, background tasks, and CLI admin/diagnostics — all on Windows
without hardcoded POSIX assumptions.

> Published on [npm](https://www.npmjs.com/package/ladder-mcp) (version badge
> above). Supported platform is **Windows 11 only**.

## Highlights

- **Agentic codegen & analysis** — point Kimi at a repo to read or edit files.
- **ACP-only transport** — `kimi_code` drives Kimi over the ACP JSON-RPC
  protocol (one `kimi acp` process per call; continuity via `session_id`), with
  granular watchable live progress and interactive permission prompts.
- **Background tasks** — run several Kimi tasks in parallel and wait for each
  with a single blocking `kimi_tasks action=wait` call (no polling loop), with a
  live TODO checklist surfaced as Kimi works.
- **Multi-agent support** — `agent_ask`, `agent_code`, `agent_status`, and `agent_tasks` add a
  provider-neutral layer. Use `provider: minimax` to route stateless asks through
  the local MiniMax `mmx` CLI; Kimi stays the default and all `kimi_*` tools are
  unchanged.
- **Independent review** — `kimi_ask` runs stateless questions or a skeptical
  second-opinion review of supplied material (no repo access, no edits).
- **Session-aware** — list, inspect, and resume Kimi sessions across the CLI
  catalog and ACP.
- **Diagnostics & setup** — one call to check install/auth/health, one to emit
  the MCP config for a Kimi-hosted server.
- **Windows-native** — resolves `kimi.exe`, `~/.kimi-code`, and PATH correctly;
  no POSIX assumptions.

## Requirements

- Windows 11
- Node.js ≥ 18
- Kimi Code CLI installed (`kimi.exe` on PATH or at `~/.kimi-code/bin/kimi.exe`),
  authenticated (`~/.kimi-code/`)
- (Optional) MiniMax CLI (`mmx` on PATH) for `agent_ask` and `agent_code` with `provider=minimax`

## Quick start (from npm)

You don't need to clone or build — the package is published on npm and your MCP
client launches it via `npx`, or you can install the package directly.

**Claude Code (one command):**

```bash
claude mcp add ladder-mcp -- npx -y ladder-mcp
```

**Or add it manually to your MCP config:**

```jsonc
{
  "mcpServers": {
    "ladder-mcp": {
      "command": "npx",
      "args": ["-y", "ladder-mcp"]
    }
  }
}
```

Then in Claude Code run `/mcp` (should show `ladder-mcp: connected`) and call
`kimi_status` to confirm the environment is detected.

> The server speaks MCP over **stdio**: it is launched and managed by the client,
> not run by hand. Running `npx ladder-mcp` directly will appear to "hang" — that
> is the server correctly waiting for a client. Exit with Ctrl+C.

Prefer a global install? `npm install -g ladder-mcp`, then use `ladder-mcp` as the
command instead of `npx -y ladder-mcp`.

Or install locally into your project:

```bash
npm install ladder-mcp
```

Then point your MCP config at `./node_modules/.bin/ladder-mcp` (or use
`npx -y ladder-mcp`, which resolves the locally installed copy when available).

To let Kimi Code itself host this server, use the `kimi_setup`
tool to produce/merge a `.kimi-code/mcp.json` entry.

## Tools

### Core (always on)

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| `kimi_code` | Agentic work in a repository — analyze and (optionally) edit files. | `prompt`*, `work_dir`*, `edit` (default `false` = analysis-only), `background`, `session_id` (continue a session), `timeout_ms` (floor 30 min) |
| `kimi_ask` | Stateless question, or independent review when `context` is supplied. Text only — no repo, no edits. | `prompt`*, `context` (switches to verify mode), `role` (reviewer persona), `timeout_ms` |
| `kimi_sessions` | List/inspect Kimi sessions from the CLI catalog, ACP, or both. | `source` (`cli`\|`acp`\|`all`, default `all`), `work_dir`, `limit` (default `20`) |
| `kimi_tasks` | Manage background work. | `action` (`wait`\|`status`\|`output`\|`cancel`)*, `task_id`, `session_id` (cancel an ACP session), `mode` (`final`\|`full`), `offset`, `limit`, `timeout_ms` (wait) |
| `kimi_status` | Installation, auth, and diagnostics. | `detail` (`basic`\|`full`), `doctor_target` (`config`\|`tui`), `doctor_path` |
| `kimi_setup` | Generate/merge the Kimi-hosted MCP config entry for this server. | `scope` (`project`\|`user`), `write` (default `false` = preview only), `project_dir`, `server_name` |
| `agent_ask` | Provider-neutral stateless question/review. | `prompt`*, `provider` (`kimi`\|`minimax`, default `kimi`), `context`, `role`, `timeout_ms` |
| `agent_code` | Provider-neutral agentic code work — analyze and (optionally) edit files. | `prompt`*, `work_dir`*, `provider` (`kimi`\|`minimax`, default `kimi`), `edit`, `background`, `session_id`, `timeout_ms` |
| `agent_status` | Installation/auth diagnostics for Kimi and MiniMax together. | `detail` (`basic`\|`full`) |
| `agent_tasks` | Provider-neutral background-task management (same store as `kimi_tasks`). | `action` (`wait`\|`status`\|`output`\|`cancel`)*, `task_id`, `session_id`, `mode`, `offset`, `limit`, `timeout_ms` |

`*` = required.

`kimi_code` drives Kimi exclusively through the ACP JSON-RPC transport. Prefer
the default **foreground** call: it blocks until Kimi finishes, streams live
progress to clients that render it (Claude Code does), and costs the host model
nothing while it waits. Set `background: true` only when you need several Kimi
tasks running in parallel.

### Experimental (off by default)

Enable with the environment variable `LADDER_EXPERIMENTAL=1`:

| Tool | Purpose |
|------|---------|
| `kimi_export_session` | Export a Kimi session ZIP (requires explicit `output_path`; excludes the global diagnostic log by default). |
| `kimi_visualize_session` | Preview or launch the Kimi session visualizer on localhost (`kimi vis --no-open`). |
| `kimi_desktop_status` | Read-only Kimi Desktop Work status probe. |
| `kimi_budget_probe` | Guided budget-separation evidence workflow (does not submit Work tasks). |

## Background tasks

Foreground (the default) is the right choice for a single task: the call blocks,
live progress is visible, and no tokens are spent while waiting. Use
`background: true` to run **several Kimi tasks in parallel** — each call returns
immediately with a task id. Then wait with one blocking call instead of a
polling loop (every status poll is a full model turn and costs tokens):

```jsonc
// 1. start two tasks in parallel
kimi_code { "prompt": "...", "work_dir": "C:\\repo1", "edit": true, "background": true }
kimi_code { "prompt": "...", "work_dir": "C:\\repo2", "edit": true, "background": true }
// 2. wait — blocks until the task finishes (or timeout_ms, default 20 min);
//    returns the status snapshot plus the last log lines
kimi_tasks { "action": "wait", "task_id": "task_1" }
// 3. read a paginated slice of the full transcript (TODO checklist + every action)
kimi_tasks { "action": "output", "task_id": "task_1", "mode": "full", "offset": 0, "limit": 100 }
// 4. quick non-blocking check — list all, or pass task_id; metadata only
kimi_tasks { "action": "status" }
// 5. stop early (kills the Kimi child process)
kimi_tasks { "action": "cancel", "task_id": "task_1" }
```

The task log keeps the **full transcript** — every progress event and each TODO
snapshot as Kimi maintains its plan. The `status` action returns only metadata;
the body is opt-in via `output`. On server shutdown all running background
tasks are cancelled so no `kimi acp` child processes are orphaned.

## Configuration

### Environment variables

| Variable | Effect |
|----------|--------|
| `LADDER_EXPERIMENTAL=1` | Register the 4 experimental tools. |
| `KIMI_API_KEY` | API key used by `kimi_ask` (alternatively set `api_key` in `~/.kimi-code/config.toml`). `KIMICODE_API_KEY` is also accepted as a legacy name. |

### Timeouts

Every tool that drives Kimi accepts a `timeout_ms` override. Defaults: ACP
`kimi_code` 30 min (1 800 000 ms) floor — smaller values are raised to the
floor; `kimi_ask` 2 min (5 min in verify mode); API 5 min; CLI admin calls 30 s.

## Safety boundaries

- `edit` defaults to `false` (analysis-only intent). Read-only is enforced at
  the ACP proxy since 1.2.0: `fs/write_text_file` requests are rejected with a
  JSON-RPC error before touching disk, and mutating permission requests are
  denied (reads stay allowed), in addition to the read-only prompt guard. This
  is best-effort hardening within the protocol — an airtight guarantee would
  require OS-level sandboxing of the Kimi process.
- `kimi_export_session` requires an explicit `output_path`, stays within the
  working directory, and excludes the global diagnostic log by default.
- Desktop Work tools are **experimental and read-only**: they do not read the
  desktop token store, replay web auth, or submit desktop Work tasks.
- The vendored `kimi-code-mcp/` is a **read-only reference** and is never edited
  or written to by the tools.

## Build from source (contributors)

```bash
npm install
npm run build      # compiles src/ -> dist/ (tests excluded)
```

Quick checks:

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit (incl. tests)
npm run dev        # run the server from source via tsx
```

## Troubleshooting

- **`ladder-mcp` not connected / tools missing** — run `kimi_status`. It reports
  whether the binary, catalog, credentials, and config are found and whether the
  API is configured.
- **`npx ladder-mcp` seems to hang** — expected; it is the stdio server waiting
  for a client. It is meant to be launched by your MCP client, not by hand.
- **`kimi_ask` errors about a missing key** — set `KIMI_API_KEY` (legacy
  `KIMICODE_API_KEY` is also accepted) or add `api_key` to
  `~/.kimi-code/config.toml`. `kimi_code` does not need this key.
- **`kimi_code` timed out** — the Kimi process is stopped on timeout, but Kimi
  persists session state on disk and the response includes a `session_id`. Call
  `kimi_code` again with that `session_id` to continue the same Kimi session.
  Resume is best-effort and not guaranteed; do not start a new task or perform
  the work yourself.

## Project layout

- `src/` — the Ladder_mcp application (package `ladder-mcp`)
- `kimi-code-mcp/` — upstream reference (read-only, MIT)

## License

[MIT](./LICENSE). Ports logic from the MIT-licensed `kimi-code-mcp` reference.
