# Changelog

All notable changes to Ladder_mcp are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-06-29 — Remediation milestone

### Added

- `kimi_status` now reports the running Ladder_mcp server version at the top of
  its output, so the live version is verifiable with a single tool call (the MCP
  `serverInfo.version` is only visible to the host at connect time).

### Breaking

- `kimi_code` is now **ACP-only**. The `transport` parameter and the native
  CLI one-shot fallback have been removed. The `kimi` binary is still used for
  `kimi acp` and admin commands (`doctor`, `sessions`, `providers`, `vis`,
  `export`).
- `kimi_tasks action=status` now returns **compact metadata only**
  (`id`, `kind`, `status`, timestamps, truncated `error`, `outputLength`). The
  full transcript is opt-in via `action=output` with `mode=final|full` and
  optional `offset`/`limit` pagination.

### Changed

- ACP `kimi_code` timeout now has a **30-minute floor** (1 800 000 ms). Any
  smaller `timeout_ms` is raised to the floor; larger values are allowed. The
  floor is defined in a single helper.
- Timeout responses from `kimi_code` now include a structured envelope with
  `session_id` and explicit continuation instructions: continue the same
  session with `new_session=false` and the returned `session_id`; do not start
  a new task or perform the work yourself. Resume is best-effort and not
  guaranteed.
- `kimi_status` now separates **CLI/ACP session auth** (used by `kimi_code`)
  from **Kimi Code API auth** (used by `kimi_ask`) and reports which tools are
  available in the current state.
- `kimi_ask` now reads `KIMI_API_KEY`; `KIMICODE_API_KEY` is still accepted as
  a legacy fallback. The error message clarifies that `kimi_code` does not
  need this key.
- All tool replies now pass through a shared size guard. Large responses are
  truncated with a notice rather than inlined whole.
- Synthetic `stall` events are now rate-limited with exponential backoff
  instead of firing every fixed interval.
- Consecutive duplicate `tool_call`/`tool_call_update` events are now
  deduplicated by `toolCallId`.
- MCP tool annotations (`title`, `readOnlyHint`, `destructiveHint`) are now set
  on every registered tool.

### Fixed

- `kimi_tasks` no longer returns `output` and `outputChunks` simultaneously.
- Background `kimi_code` progress is written only to the task store; it no
  longer attempts to notify a closed MCP response channel.
- Task IDs now include a random suffix to avoid collisions across restarts.
- Task `error` strings are truncated in status snapshots so a huge stack trace
  cannot blow the response budget.
- ACP fs writes are now atomic (temp file + rename).
- `extractTextDeep` recursion is now depth-bounded.
- `canonicalizePath` rejects paths whose ancestors do not exist under a real
  directory instead of returning a potentially-escaping resolved path.
- `kimi_ask` now honors `max_output_tokens` for the response size guard; long
  answers were previously capped at the 8 KB default regardless of the budget.
- `kimi_code` success responses keep the terminal envelope (`session_id` /
  continuation) even when the body is truncated by the size guard.
- Background `kimi_code` preserves the `session_id` in the task error on a
  resumable timeout so the session can still be continued via `kimi_tasks`.
- `kimi_tasks` `output` reports zero lines for an empty task log instead of a
  single phantom empty line.
- ACP responses surface thinking text as the body when there are no assistant
  message chunks, instead of returning an empty response.

## [1.1.6] - 2026-06-28

ACP is now the default kimi_code transport.

### Changed

- `kimi_code` defaults to `transport: 'acp'` (was `'cli'`); CLI stays as the
  explicit opt-in (`transport: 'cli'`). Tool/parameter descriptions, README, and
  tests updated to match.

### Docs

- README points to the Kimi CLI repo (https://github.com/MoonshotAI/kimi-cli).

## [1.1.5] - 2026-06-28

Turn Kimi's TODO/plan into a watchable live checklist.

### Added

- Kimi's working TODO list is now surfaced as a `todo` progress event in both
  transports. A shared `createTodoTracker` holds the current `{ text, status }`
  list (replaced on each update) and renders a compact one-line summary
  (`TODO 2/4 ✓✓·· · now: <current item>`) for the live progress line, plus the
  full multi-line snapshot in the background task log.
- **CLI**: `role:tool` `TodoList` results (the `Current todo list:` text
  snapshot) are parsed and tracked. **ACP**: structured `tool_call_update`/`plan`
  TODO payloads — JSON `{"todos":[{title,status}]}` or the text snapshot — are
  parsed into the same tracker. The normal `tool_call`/`plan` action event is
  still emitted alongside the `todo` event, so actions stay visible.
- The progress coalescer gains a TODO-priority dwell window (`todoPriorityMs`,
  default 5s): after a TODO update, chatty `message`/`thought` previews are
  suppressed so the checklist line stays readable, while `tool_call`,
  `tool_update`, and `plan` actions still surface immediately. Suppressed preview
  tails are never lost — they flush on the next TODO, on window expiry, and on
  stop/cancel.

### Changed

- The background task log now uses `formatTaskLogLine`, which indents the full
  TODO snapshot under the compact summary; foreground/MCP progress stays on the
  compact `formatProgressLine`.
- Removed the CLI stall watchdog. Kimi CLI 0.20.1 works silently during long
  thinking phases, so the watchdog produced false `stall` warnings. The ACP
  transport keeps its watchdog (it streams granular per-action activity).

### Notes

- Additive change: the existing `tool_call`/`tool_update`/`message`/`thought`/
  `plan` events and the task log are otherwise unchanged — `todo` is an added
  layer. No new runtime dependency; `kimi-code-mcp/` untouched.

## [1.1.4] - 2026-06-28

Make the live-progress line worth watching.

### Changed

- Live progress now shows a readable content **preview** of the streamed
  `message`/`thought` text (whitespace collapsed, code-point-safe truncation with
  an ellipsis) instead of a bare `(N chars)` counter.
- Progress emission is throttled to at most one update per ~1.2s, so the single
  progress line stops flickering and each line stays readable. `tool_call`,
  `tool_update`, and `plan` events remain immediate and flush any pending preview
  first to preserve order.
- The two per-transport coalescers (CLI and ACP) are unified into one shared
  `createProgressCoalescer` in `src/progress.ts`; the duplicated `COALESCE_*`
  constants are gone.

### Notes

- Kimi CLI 0.20.1 does not stream thinking to stderr during `-p` runs, so live
  `thought` progress is not available on the CLI transport (documented in code).
  The ACP transport already emits `thought`, which now gets the preview treatment.

## [1.1.3] - 2026-06-28

Bugfix: analysis-mode `kimi_code` was broken against Kimi CLI 0.20.1.

### Fixed

- `kimi_code` without `edit: true` (the default analysis mode) crashed against
  Kimi CLI 0.20.1 with `Cannot combine --prompt with --plan`. `buildKimiArgs` no
  longer passes `--plan` in `-p` prompt mode (the CLI rejects it, along with
  `--auto`/`-y`).

### Changed

- Because Kimi 0.20.1 has no `-p`-compatible read-only flag, the `edit: false`
  analysis-only contract is now enforced at the prompt level: `runKimi` prepends
  a read-only guard (`applyReadOnlyGuard`) when `edit` is not `true`. This is
  advisory (the model is instructed not to edit) rather than a hard CLI
  guarantee; the `edit` parameter description documents the change.

## [1.1.2] - 2026-06-28

Live-progress and cancellation reliability for `kimi_code`.

### Added

- The CLI transport now surfaces the running action: `stream-json` `tool_calls`
  records emit immediate `tool_call` progress events (e.g. `Read src/types.ts`)
  and `plan` records emit `plan` events, matching the ACP transport. A CLI job
  no longer looks idle while it works.

### Fixed

- Cancelling a `kimi_code` call now actually kills the underlying `kimi.exe`
  process in every mode (foreground CLI, background CLI, foreground ACP).
  Previously only background ACP honored cancellation; the others leaked the
  child until the timeout fired. `runKimi` accepts an `AbortSignal`, skips
  spawning when already aborted, and kills the process tree on abort.
- The ACP client is hardened against a `close()`-before-`start()` race, and an
  aborted ACP run now reports `Kimi cancelled` instead of a raw exit code.

### Changed

- `kimi_code`'s `transport` and `background` parameter descriptions now explain
  the cli/acp trade-off and where to read the full progress log, so agents pick
  a mode deliberately.

## [1.1.0] - 2026-06-28

Breaking tool-surface redesign: the MCP tool list is now an intent-first set of
6 default tools, with niche/admin features gated behind `LADDER_EXPERIMENTAL=1`.

### Changed

- `src/index.ts` now registers 6 default tools: `kimi_code`, `kimi_ask`,
  `kimi_sessions`, `kimi_tasks`, `kimi_status`, `kimi_setup`.
- `kimi_code` folds `kimi_analyze`, `kimi_resume`, and `kimi_chat`. It defaults to
  `transport='cli'` (validated `work_dir` via `validateWorkDir`) and supports
  `edit`, `background`, `session_id`, and `new_session`.
- `kimi_ask` folds `kimi_query` and `kimi_verify`; providing `context` switches to
  verify mode.
- `kimi_sessions` folds `kimi_list_sessions` and `kimi_acp_sessions` behind the
  `source` parameter (`cli`, `acp`, `all`).
- `kimi_tasks` action-dispatches `status`, `output`, and `cancel` (including ACP
  session cancellation via `session_id`).
- `kimi_status` detail-switches between `basic` and `full`; `full` adds
  capabilities, doctor, and provider list. `isError` is now true whenever a
  remediation is required.
- `kimi_setup` renames `kimi_generate_mcp_config` and resolves the default server
  command from `process.execPath`.

### Removed

The 20-tool default surface is replaced by the 6 tools above. The following tool
names are no longer registered by default:

- `kimi_analyze`, `kimi_resume`, `kimi_chat`
- `kimi_query`, `kimi_verify`
- `kimi_list_sessions`, `kimi_acp_sessions`
- `kimi_task_status`, `kimi_task_output`, `kimi_task_cancel`, `kimi_cancel`
- `kimi_capabilities`, `kimi_doctor`, `kimi_provider_list`
- `kimi_generate_mcp_config`

### Migration

| Old tool | New |
|---|---|
| `kimi_analyze` | `kimi_code` (edit=false) |
| `kimi_resume` | `kimi_code` (session_id set) |
| `kimi_chat` | `kimi_code` (transport='acp') |
| `kimi_query` | `kimi_ask` |
| `kimi_verify` | `kimi_ask` (context/role set) |
| `kimi_list_sessions` | `kimi_sessions` (source='cli') |
| `kimi_acp_sessions` | `kimi_sessions` (source='acp') |
| `kimi_task_status` | `kimi_tasks` (action='status') |
| `kimi_task_output` | `kimi_tasks` (action='output') |
| `kimi_task_cancel` | `kimi_tasks` (action='cancel') |
| `kimi_cancel` | `kimi_tasks` (action='cancel', task_id or session_id) |
| `kimi_status` | `kimi_status` |
| `kimi_capabilities` | `kimi_status` (detail='full') |
| `kimi_doctor` | `kimi_status` (detail='full') |
| `kimi_provider_list` | `kimi_status` (detail='full') |
| `kimi_generate_mcp_config` | `kimi_setup` |
| `kimi_export_session` | experimental (unchanged name) |
| `kimi_visualize_session` | experimental |
| `kimi_desktop_status` | experimental |
| `kimi_budget_probe` | experimental |

The 4 experimental tools (`kimi_export_session`, `kimi_visualize_session`,
`kimi_desktop_status`, `kimi_budget_probe`) now register only when
`process.env.LADDER_EXPERIMENTAL === '1'`.

### Added

- **Bidirectional ACP transport** (`transports/acp.ts`): the bridge now answers the
  agent's client-bound JSON-RPC requests, so file edits and permission flows over
  ACP complete instead of hanging. Includes auto-approved `session/request_permission`
  and a `fs/read_text_file`/`fs/write_text_file`/`fs/read_directory` proxy.
- **Live-progress visibility**: long-running `kimi_code` work surfaces progress —
  background tasks grow a timestamped log, foreground calls emit MCP
  `notifications/progress`, and a stall watchdog flags silent hangs. Token streams
  are coalesced so the log is readable.
- **Single-source versioning** (`version.ts`) read from `package.json`, plus
  `release:patch/minor/major` scripts and a `preversion` typecheck+test gate.

### Security

- **ACP fs proxy is sandboxed** to the session `work_dir` with realpath-based
  containment (blocks symlink/junction escape, case-folding bypass, drive-relative
  and UNC paths); fails closed when the work dir is unset. Permission auto-approve
  fails closed when no single-use option is offered. File reads are size-capped.
- **`assertSafeCommand`** (`kimi-mcp-config.ts`) rejects PATH-resolved bare
  `node`/`npx`, accepting only `process.execPath` or an absolute existing file;
  `assertWritableProjectTarget` uses realpath containment instead of substring match.

### Fixed

- Process-tree termination on Windows (`taskkill /T /F`) for ACP close/cancel and
  `runKimi` timeout, with awaited exit so callers don't race a dying tree.
- Timeouts in `runKimi` and `runKimiApi` are clamped; `timeout_ms` tool args must be
  positive integers.
- `parseKimiStreamJson` tolerates leading whitespace; resume-hint extraction is
  fuzzier; `contentToText` keeps placeholders for non-text parts.
- `task-store` no longer appends to terminal tasks; `runKimi` preserves both stdout
  and stderr on failure; disk-discovered sessions recover their real `work_dir`.
- Capped the `readBodyCapped` non-streaming fallback (`desktop-work.ts`).

## [1.0.2] - 2026-06-28

Security and robustness patch release addressing findings from an external
adversarial review of `src/`.

### Fixed

- **`isAuthenticated` false-positive on corrupt credentials** (`environment.ts`):
  a credentials file that exists but is unreadable or invalid JSON was previously
  reported as authenticated. It now fails closed and returns `false`, satisfying
  NFR-5 honest diagnostics.
- **Unbounded `stdout`/`stderr` capture in `runKimi`** (`kimi-runner.ts`): CLI
  output is now accumulated through `appendCapped` with a hard ceiling
  (`MAX_CAPTURE_CHARS`), preventing memory exhaustion on runaway output.
- **Unvalidated `max_output_tokens` and `work_dir`** (`input-validation.ts`):
  non-finite, zero, or negative token counts are clamped to the default budget;
  `work_dir` must be an absolute path to an existing directory before Kimi is
  spawned. Used by `kimi_analyze` and `kimi_resume`.

### Security

- **Arbitrary command persisted to `mcp.json`** (`kimi-mcp-config.ts`):
  `kimi_generate_mcp_config` now validates `command` against an allow-list of
  `node`, `npx`, or an absolute path to an existing file. Other values (e.g.
  `powershell`) are rejected and nothing is written.

## [1.0.1] - 2026-06-28

Bug-fix release. Issues found by exercising all 20 tools live against a real
Kimi CLI (the mock-only unit tests had missed them).

### Fixed

- **ACP responses lost spaces** (`kimi_chat`): streamed token chunks were each
  trimmed and newline-joined, so `"Two plus two equals four."` came back as
  `"Twoplustwoequalsfour."`. Text fragments are now concatenated as-is and only
  the final string is trimmed. (CLI tools `kimi_analyze`/`kimi_resume` were never
  affected.)
- **`kimi_export_session` silently no-op'd** while reporting `ok: true`: when no
  session id was given, `kimi export` defaults to the most recent session and asks
  `Export previous session …? [Y/n]` — a prompt that `-y` does not suppress in Kimi
  CLI 0.20.1, so with stdin closed it exited 0 without writing. The tool now
  resolves the most recent session id itself and passes it explicitly (skipping the
  prompt), always passes `-y`, and verifies the output file exists before reporting
  success.

### Changed

- `kimi_acp_sessions` now accepts `limit` (default 20) and `work_dir` filters,
  for parity with `kimi_list_sessions`; previously it dumped every ACP session
  across all projects in one response.

## [1.0.0] - 2026-06-27

First release. Windows-first MCP bridge for Kimi Code CLI v24, rebuilt in a
fresh `./src` application (package `ladder-mcp`). Logic is ported from the
read-only `kimi-code-mcp/` reference; the legacy `CacheManager`/warmup layer is
not carried over.

### Added — v1 core (Epics 1-3)

- Robust environment resolver (`environment.ts`): discovers `kimi.exe` via PATH
  and `~/.kimi-code/bin/`, resolves the `~/.kimi-code/` catalog, credentials and
  version with no hardcoded POSIX paths; no silent fallback to legacy `~/.kimi/`.
- CLI adapter (`kimi-runner.ts`): correct Kimi CLI v24 arguments
  (`-p`, `--output-format stream-json`, `-S`, `-C`, `--auto`), `stream-json`
  parsing, native session resume, Windows process-tree termination on timeout.
- API adapter (`kimi-api.ts`): contextless `kimi_query` / `kimi_verify` reading
  key/endpoint from `KIMICODE_API_KEY` or `~/.kimi-code/config.toml`.
- Six v1 MCP tools: `kimi_analyze`, `kimi_query`, `kimi_verify`, `kimi_resume`,
  `kimi_list_sessions`, `kimi_status`.

### Added — vNext expansion (Epic 4)

- **CLI admin & capabilities** (`transports/cli-admin.ts`): `kimi_capabilities`,
  `kimi_doctor`, `kimi_provider_list`, `kimi_export_session`,
  `kimi_visualize_session`. Export requires an explicit `output_path`, is
  confined to the working directory, and excludes the global diagnostic log by
  default.
- **ACP MVP over stdio** (`transports/acp.ts`): JSON-RPC client for `kimi acp`
  with newline-delimited and `Content-Length` framing; `kimi_chat`,
  `kimi_acp_sessions`, `kimi_cancel`.
- **Background task lifecycle** (`task-store.ts`): in-process task store with
  `kimi_chat background=true`, `kimi_task_status`, `kimi_task_output`,
  `kimi_task_cancel`.
- **Kimi-hosted MCP config + read-only desktop probes**
  (`kimi-mcp-config.ts`, `desktop-work.ts`): `kimi_generate_mcp_config`,
  `kimi_desktop_status`, `kimi_budget_probe`. Desktop access is
  experimental/read-only — no token-store reads, no web-auth replay, no desktop
  Work task submission.

### Security & robustness (adversarial review)

Hardened against path traversal/TOCTOU on export, writes under the read-only
reference tree, unbounded ACP frame/task memory, process crash on malformed ACP
JSON, non-idempotent task cancellation, and UTF-8 byte-boundary truncation.

The remaining lower-risk review findings (W1-W12) were also resolved before
release: raw ACP response-id matching (no `NaN` coercion), bounded ACP update
buffer, clamped ACP request timeouts, smaller buffers for parallel capability
probes, a timeout around task cancel hooks, a size cap on the desktop status
probe body, validated `kimi_chat` timeout input, and `kimi_cancel` rejecting
ambiguous task_id+session_id calls. Regression tests added (49 total).

### Known limitations

- Windows 11 only (NFR-1); POSIX branches are not a target.

[1.0.0]: https://semver.org/
