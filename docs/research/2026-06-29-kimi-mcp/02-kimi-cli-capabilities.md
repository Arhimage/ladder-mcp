# Kimi CLI Capabilities — Research for ladder-mcp wrapper

Date: 2026-06-29
Target: Kimi CLI ~0.20.1
Local install verified: `C:\Users\shers\.kimi-code\bin\kimi.exe`, `kimi --version` → **0.20.1**

## IMPORTANT: two different products share the "Kimi CLI" name

| Product | Repo | Runtime | Versioning | Docs | Config dir |
|---|---|---|---|---|---|
| **Kimi Code CLI** (what ladder-mcp wraps; local 0.20.1) | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | **Node.js ≥ 24.15.0**, TypeScript, single-binary | **0.x** (0.20.2 latest 2026-06-29) | https://moonshotai.github.io/kimi-code/ | `~/.kimi-code/` |
| Legacy Kimi CLI | [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) | **Python** 3.12–3.14 | **1.x** (1.4x) | https://moonshotai.github.io/kimi-cli/ | `~/.kimi-cli/` |

The local binary is **kimi-code** (Node), not the Python kimi-cli. Many GitHub issues that surface for "kimi" Windows/asyncio crashes (e.g. #1997, #2151) belong to the **Python** product and do NOT apply to our Node binary. Cite carefully. The two docs sites cross-link and the kimi-code site sometimes 404s pages that exist on the kimi-cli site.

---

## Capability matrix

| Capability | How to use (flag/cmd) | Reported issue it addresses | Confidence / source |
|---|---|---|---|
| Non-interactive single prompt with result | `kimi -p "<prompt>"` (a.k.a. `--prompt`) — runs one prompt, prints response, no TUI | #2 OUTPUT, #4 SUBAGENTS (single-shot) | **High** — local `--help`; [kimi-command ref](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html) |
| Structured output | `--output-format text|stream-json` (only valid with `-p`) | #2 OUTPUT (final-answer vs action log) | **High** — local `--help` + ref |
| Final-answer-only (planned, not in 0.20.1) | `--final-message-only` / `--quiet`, `--input-format`, errors-as-JSON, exit code 75 for retryable | #2 OUTPUT, #5 TIMEOUTS (retryable signalling) | **Medium** — open PR [#1199](https://github.com/MoonshotAI/kimi-code/issues/1199), NOT yet in 0.20.1 |
| Resume a specific session | `kimi -S <id>` / `--session <id>`; `-S` with no id = interactive picker | #3 SESSIONS | **High** — local `--help` |
| Continue last session in cwd | `kimi -c` / `--continue` | #3 SESSIONS | **High** — local `--help` |
| Session index (cheap status query) | Read `~/.kimi-code/session_index.jsonl` (JSONL: `sessionId`, `sessionDir`, `workDir`) — no process spawn needed | #3 SESSIONS (cheap metadata) | **High** — local file inspected |
| Session state on disk | `~/.kimi-code/sessions/wd_<slug>_<hash>/session_<uuid>/` | #3 SESSIONS | **High** — local `session_index.jsonl` paths |
| Export / inspect a session | `kimi export [sessionId] -o out.zip`; `kimi vis [sessionId]` (browser visualizer) | #3 SESSIONS | **High** — local `--help` |
| Plan mode (read-only, less delegation) | `kimi --plan` or config `default_plan_mode=true` | #4 SUBAGENTS, analytic prompt | **High** — local `--help` + [config-files](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html) |
| Restrict skills | `--skills-dir <dir>` (replaces auto-discovery; point at empty dir to suppress); config `merge_all_available_skills=false`, `extra_skill_dirs=[]` | #4 SUBAGENTS/SKILLS | **High** — local `--help` + config-files |
| Limit delegation/loop depth | config `[loop_control] max_steps_per_turn`, `max_retries_per_step`, `max_ralph_iterations` | #4 SUBAGENTS depth | **High** — local `config.toml` |
| Restrict the Agent (subagent) tool | Custom agent profile YAML with `allowed_tools`/`exclude_tools` (Agent tool is allowed by default) | #4 SUBAGENTS | **Medium** — [agents docs](https://moonshotai.github.io/kimi-code/en/customization/agents.html); no global flag exists |
| ACP server for IDE/client | `kimi acp` (stdio); `kimi acp --login` runs device-code login then exits | #1 AUTH, #5 ACP | **High** — local `--help` |
| Device-code login (OAuth) | `kimi login` | #1 AUTH | **High** — local `--help` |
| Config validation | `kimi doctor config [path]`, `kimi doctor tui [path]` | setup/diagnostics | **High** — local `--help` |
| Background-task tuning (heartbeat/timeout) | config `[background]` block: `agent_task_timeout_s`, `print_wait_ceiling_s`, `worker_heartbeat_interval_ms`, `worker_stale_after_ms`, `wait_poll_interval_ms`, `kill_grace_period_ms` | #5 TIMEOUTS | **High** — local `config.toml` |
| Auto-approve / permission modes | `-y/--yolo`, `--auto` (note: `-p` already runs under `auto` policy) | tool-approval hangs | **High** — local `--help` + ref |
| Add workspace dirs | `--add-dir <dir>` (repeatable) | scope | **High** — local `--help` |
| Local REST/WS server | `kimi server run` / `ps` / `kill` / `rotate-token`; `kimi web` UI | alt transport | **High** — local `--help` |
| Custom HTTP headers | env `KIMI_CODE_CUSTOM_HEADERS` (or `custom_headers` table) | proxy/header injection | **Medium** — config-files + 0.20.2 changelog |

---

## Per-area notes

### 1. AUTH — one OAuth identity serves both `ask` and `code`

The modern **kimi-code** auth model is **OAuth device-code**, not API keys, for the managed service:

- `kimi login` runs the device-code flow. The toolchain "automatically writes and refreshes credentials — no manual configuration is needed in `config.toml`" ([providers docs](https://moonshotai.github.io/kimi-code/en/configuration/providers.html)).
- Local `config.toml` confirms this. The managed provider has an **empty** `api_key` and an OAuth pointer instead:
  ```toml
  [providers."managed:kimi-code"]
  type = "kimi"
  api_key = ""
  base_url = "https://api.kimi.com/coding/v1"
  [providers."managed:kimi-code".oauth]
  storage = "file"
  key = "oauth/kimi-code"
  ```
- OAuth tokens live in `~/.kimi-code/credentials/kimi-code.json` (verified present locally; contents not read — credential material).
- Env var for a manual key is **`KIMI_API_KEY`** (+ `KIMI_BASE_URL`), per provider env table — **not** `KIMICODE_API_KEY`. No `KIMICODE_API_KEY` is documented anywhere; that name in ladder-mcp appears to be a wrapper invention. The CLI does **not** fall back to shell env for managed credentials — keys must be in `config.toml` `[providers.<n>]` `api_key` or `[providers.<n>.env]`.
- **One identity covers both paths**: the same provider/OAuth that powers an interactive `kimi` session also powers `kimi -p` (print/"ask"-style) and `kimi acp`. There is no separate auth for an "API ask" vs an "interactive session" in kimi-code itself.
- **Known ACP auth wart**: [#799](https://github.com/MoonshotAI/kimi-code/issues/799) — `kimi acp` historically **required** `--login` and ignored `config.toml` credentials. Fix work: [#934](https://github.com/MoonshotAI/kimi-code/issues/934) `fix(acp): allow configured provider auth`. This is exactly ladder-mcp's "kimi_code works off an authenticated session while kimi_ask needs a key" split: ACP auth and key/config auth were not unified. **Mitigation for the wrapper: standardize on one OAuth login (`kimi login` once), and let both `-p` and `acp` use the shared `~/.kimi-code` credentials.**

### 2. OUTPUT FORMAT — structured mode exists today, richer mode is incoming

- **Today (0.20.1):** `kimi -p "<prompt>" --output-format stream-json` emits JSONL events instead of a TUI transcript. `--output-format text` (default) prints plain text. This already separates a machine-consumable stream from interactive rendering.
- `-p` mode runs under the `auto` permission policy (no human approval prompts), so it won't block waiting for approvals.
- **Coming (open PR [#1199](https://github.com/MoonshotAI/kimi-code/issues/1199), NOT in 0.20.1):** `--final-message-only`, `--quiet` (= `--output-format text --final-message-only`), `--input-format text|stream-json` (stdin, multi-turn), thinking emitted as its own JSONL line, notifications as JSON lines, and **errors as JSON with exit codes** (`75` = retryable provider error: connection/timeout/rate-limit/5xx; `1` otherwise). This is the cleanest future answer to "final answer + metadata separate from the action log" — track this PR/release.

### 3. SESSIONS / RESUME

- Resume: `kimi -S <id>` (specific) or `kimi -S` (picker); `kimi -c` continues the cwd's latest.
- **Cheap status without spawning kimi:** read `~/.kimi-code/session_index.jsonl` — one JSON object per line with `sessionId`, `sessionDir`, `workDir`. The wrapper can list/filter sessions by working dir from this file directly. Per-session payload lives under `sessionDir`.
- Export `kimi export [id] -o x.zip`; visualize `kimi vis [id]`.
- **Resume is fragile** — many open bugs: [#660](https://github.com/MoonshotAI/kimi-code/issues/660) "Impossible to resume crashed sessions", [#269](https://github.com/MoonshotAI/kimi-code/issues/269) resume breaks after force-interrupt during tool execution (400, missing tool_call_ids), [#1152](https://github.com/MoonshotAI/kimi-code/issues/1152) resume auto-creates a new session, [#1110](https://github.com/MoonshotAI/kimi-code/issues/1110) stale closed sessions on resume, [#771](https://github.com/MoonshotAI/kimi-code/issues/771)/[#664](https://github.com/MoonshotAI/kimi-code/issues/664)/[#723](https://github.com/MoonshotAI/kimi-code/issues/723) orphan/incomplete tool calls on resume. **Implication: cancelling mid-tool then resuming is a known landmine; prefer a fresh session over resuming an interrupted one.**

### 4. SUB-AGENTS / SKILLS — no single "off" switch; use plan mode + profiles

- Subagents are **auto-dispatched** by the main agent ("without the user having to specify one"). Built-in types: `coder`, `explore` (read-only), `plan`. The `Agent` tool is **allowed by default**. ([agents docs](https://moonshotai.github.io/kimi-code/en/customization/agents.html))
- There is **no documented global `--no-subagents` / `--no-skills` flag.** Mitigations:
  - `--plan` (or `default_plan_mode=true`): biases to read-only exploration tools — good for a single analytic prompt.
  - Define a **custom agent profile (YAML)** that omits the `Agent` tool via `allowed_tools`/`exclude_tools` to prevent delegation (schema documented on the kimi-cli agents page; partial coverage on kimi-code).
  - Skills: `--skills-dir <emptydir>` to bypass auto-discovered skills for one run; or `merge_all_available_skills=false` + empty `extra_skill_dirs`.
  - Delegation/iteration depth: `[loop_control] max_steps_per_turn`, `max_retries_per_step`, `max_ralph_iterations`.
- Boundary clarification [#1143](https://github.com/MoonshotAI/kimi-code/issues/1143): Kimi subagents are Kimi-runtime agents on the current model/provider; `kimi acp` makes Kimi **the** agent (not an ACP client dispatching to other agents).

### 5. TIMEOUTS / ACP

- `kimi acp` runs an ACP server over stdio. No documented hard wall-clock limit on `session/prompt` in the public docs.
- **Real risk is a silent stall, not a fixed timeout:** [#1050](https://github.com/MoonshotAI/kimi-code/issues/1050) — the streaming generator (`packages/kosong/src/generate.ts`) has **no between-chunk idle timeout**; if the model stream goes silent (connection ESTABLISHED, no bytes), it "waits forever" and the UI stays in "thinking" with no recovery but killing the process. There IS a first-byte timeout and request-level retry, but no idle/heartbeat timeout. **The wrapper must impose its own idle/overall timeout and kill the child** — do not rely on kimi to time out a stalled prompt.
- Configurable knobs that DO exist (local `config.toml`, background tasks): `agent_task_timeout_s=900`, `print_wait_ceiling_s=3600`, `worker_heartbeat_interval_ms=5000`, `worker_stale_after_ms=15000`, `kill_grace_period_ms=2000`, `wait_poll_interval_ms=500`, `keep_alive_on_exit=false`. These govern **background tasks**, not the foreground ACP prompt stream.
- Related ACP hardening (all kimi-code): [#996](https://github.com/MoonshotAI/kimi-code/issues/996) line-range reads, [#936](https://github.com/MoonshotAI/kimi-code/issues/936) tolerate missing MCP fields, [#940](https://github.com/MoonshotAI/kimi-code/issues/940) malformed catalog, [#939](https://github.com/MoonshotAI/kimi-code/issues/939) unknown turn-end reasons, [#912](https://github.com/MoonshotAI/kimi-code/issues/912) commands in permission requests.

### 6. WINDOWS STABILITY (issue #9 area)

- **No kimi-code issue was found that names `0xC0000409` / `STATUS_STACK_BUFFER_OVERRUN` directly.** Treat that specific crash as **unverified** against kimi-code; it may be a Node/V8 native crash or originate in the wrapper's child handling. (`STATUS_STACK_BUFFER_OVERRUN` is a generic Windows fast-fail, not necessarily a real overflow — see [The Old New Thing](https://devblogs.microsoft.com/oldnewthing/20190108-00/?p=100655).)
- Confirmed kimi-code Windows items: [#550](https://github.com/MoonshotAI/kimi-code/issues/550) spawn EINVAL on Windows (node-sdk), [#504](https://github.com/MoonshotAI/kimi-code/issues/504) needs `shell:true` when spawning `.cmd` shims, [#886](https://github.com/MoonshotAI/kimi-code/issues/886)/[#909](https://github.com/MoonshotAI/kimi-code/issues/909) MCP stdio UTF-8/charmap crashes, [#1118](https://github.com/MoonshotAI/kimi-code/issues/1118) runaway Python runner processes, [#1144](https://github.com/MoonshotAI/kimi-code/issues/1144) Windows test job disabled in CI (Windows is under-tested).
- Changelog **0.20.1 (2026-06-26)** explicitly fixed "kimi server failing to start on Windows after the first run" — so resume/restart Windows bugs are actively in flux around our exact version.
- Windows requires **Git for Windows**; shell path overridable via `KIMI_SHELL_PATH`.
- The asyncio/Python-3.13 Windows hangs ([#1997](https://github.com/MoonshotAI/kimi-cli/issues/1997), [#2151](https://github.com/MoonshotAI/kimi-cli/issues/2151)) are **kimi-cli (Python)** — not applicable to the Node binary.

### 7. Full subcommand / flag inventory (from local `kimi --help`, 0.20.1)

Top-level flags: `-V/--version`, `-S/--session [id]`, `-c/--continue`, `-y/--yolo`, `--auto`, `-m/--model <model>`, `-p/--prompt <prompt>`, `--output-format text|stream-json`, `--skills-dir <dir>` (repeatable), `--add-dir <dir>` (repeatable), `--plan`, `-h/--help`.

Subcommands: `export`, `provider` (`add`/`remove`/`list`/`catalog`), `acp` (`--login`), `server` (`run`/`ps`/`kill`/`rotate-token`), `web`, `login`, `doctor` (`config`/`tui`), `vis`, `migrate`, `upgrade|update`.

Docs root: **https://moonshotai.github.io/kimi-code/** · Repo: **https://github.com/MoonshotAI/kimi-code**

---

## Open questions / unverified

1. **`0xC0000409` / STATUS_STACK_BUFFER_OVERRUN on resume** — not reproduced or filed against kimi-code. Needs first-hand repro (capture stderr + Windows event log when it fires). Likely interacts with the known resume bugs (#660/#269/#1110) and/or Windows spawn issues (#550/#504).
2. **Hard ACP `session/prompt` timeout** — none documented; behavior is "wait forever on silent stream" (#1050). Confirm whether kimi-code 0.20.1 has ANY idle abort (appears not). Wrapper must own the timeout.
3. **`--final-message-only` / `--quiet` / JSON errors+exit-code-75** — in PR [#1199](https://github.com/MoonshotAI/kimi-code/issues/1199), NOT in 0.20.1. Verify which release lands it before depending on it.
4. **Global subagent disable** — no flag confirmed; the `allowed_tools`/`exclude_tools` profile route is documented mainly on the kimi-cli (Python) agents page and only partially on kimi-code. Verify the YAML schema works identically in kimi-code 0.20.1.
5. **`stream-json` event schema for 0.20.1** — exact event shapes not captured here (avoided running a live prompt). Capture by running one short `kimi -p ... --output-format stream-json` when safe.
6. **ACP auth unification (#799/#934)** — confirm whether 0.20.1 already lets `kimi acp` use `config.toml`/OAuth without a fresh `--login`, or if `acp --login` is still mandatory.
7. **`KIMICODE_API_KEY`** — not a real kimi-code env var (real one is `KIMI_API_KEY`). Confirm where ladder-mcp's `KIMICODE_API_KEY` expectation came from and migrate to OAuth or `KIMI_API_KEY`.
