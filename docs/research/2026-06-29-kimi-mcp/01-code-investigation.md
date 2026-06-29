# Code Investigation — ladder-mcp (Kimi CLI 0.20.1 wrapper)

Date: 2026-06-29
Scope: read-only root-cause trace of the 10 issues in `kimi-mcp-issues-2026-06-29.md`.
Repo: `C:\Users\shers\source\repos\Ladder_mcp`, source in `src/`.

All line numbers refer to the source files as they exist at commit `c74fe22`.

## Summary table

| # | File:line | Root-cause hypothesis | Fix area |
|---|-----------|-----------------------|----------|
| 1 | `src/kimi-api.ts:23-30`, `src/environment.ts:108-137` & `:164-178`, `src/index.ts:285-300` | Two independent auth paths. `kimi_ask` requires the **REST API key** (`loadApiAuth`: `KIMICODE_API_KEY` / `api_key`); `kimi_code` rides the **OAuth CLI/ACP session** (`isAuthenticated`: token file). `kimi_status` "Authenticated" = OAuth, "Kimi Code API Configured" = REST key — different facts, so "Authenticated: Yes" + `kimi_ask` failure are both correct but look contradictory. | Auth unification / status messaging |
| 2 | `src/index.ts:243-249`, `src/task-store.ts:185-199` | `kimi_tasks action:status` serializes the **entire task snapshot** (full `output` ≤100k + `outputChunks` ≤100k) via `JSON.stringify(task, null, 2)`. No metadata-only mode; listing does the same for every task. | kimi_tasks status payload slimming |
| 3 | `src/task-store.ts:185-199` & `:115-125`, `src/index.ts:256` | Snapshot carries **both** the joined `output` string and the `outputChunks[]` it was joined from — the same bytes twice. `action:output` returns both. | Task object dedup |
| 4 | `src/kimi-runner.ts:258-266` & `:316-321`, `src/index.ts:131-133` | Timeout result is `{ ok:false, text:'', error:'Kimi timed out after 600s' }` — **no `sessionId`, no resumable flag, no touched files**. `sessionId` is only parsed from stdout at clean exit (`:337-340`), which never runs after the kill. | Timeout payload enrichment |
| 5 | `src/transports/acp.ts:14` & `:328-335`, `src/index.ts:143` & `:160`, `src/progress.ts:3` & `:325-356` | `session/prompt` uses `this.timeoutMs`, which defaults to `DEFAULT_ACP_TIMEOUT_MS = 120_000` (~2 min) when `timeout_ms` is omitted — far below the CLI's 600s. Stall watchdog re-arms every 30s, flooding the log. | ACP timeout default / keepalive |
| 6 | `src/kimi-runner.ts:316-335` | Non-zero exit builds `kimi exited with code <code>`. On a native fail-fast crash (`0xC0000409`) stderr/stdout are empty, so the message is just the raw decimal code — no hex, no crash explanation, no resumable hint. | CLI crash diagnostics |
| 7 | `src/index.ts:265-267`, `src/task-store.ts:90-113` & `:185-199` | `action:cancel` returns the **full snapshot** (`JSON.stringify(task)`) including accumulated `output`+`outputChunks`. Tasks with a large log → giant payload; tasks with little output → clean JSON. Non-determinism is a function of how much had streamed. | kimi_tasks cancel payload slimming |
| 8 | Not in this repo (harness behavior); driven by `src/index.ts:246/248/256/267` | ladder-mcp never writes results to disk and has **no response-size guard**. The "exceeds maximum allowed tokens / saved to … / you MUST read 100%" file and its single-line JSON come from the **MCP client (Claude Code)** truncating the oversized tool response. Server returns `JSON.stringify(..., null, 2)` (multi-line) but the harness re-serializes the wrapper. | Server-side size guard so harness never triggers |
| 9 | `src/kimi-runner.ts:38-50` & `:52-60`, `src/transports/acp.ts:328-335`, `src/index.ts:137-145` | Nothing constrains Kimi's sub-agent/skill spawning. CLI path only prepends a prose `READ_ONLY_GUARD`; **ACP path passes the prompt verbatim** with no guard and no delegation-depth/skill control. `buildKimiArgs` notes `--plan/--auto/-y` are incompatible with `-p`, so no hard flag exists. | Delegation/skill control |
| 10 | `src/transports/acp.ts:616-641`, `src/progress.ts:283-307` | `tool_call` and the subsequent `tool_call_update` for the same tool carry near-identical content; both are forwarded with **no de-duplication**, so the same long prompt/title is logged twice in a row. | ACP event de-dup |

---

## Per-issue detail

### Issue 1 — AUTH SPLIT (`kimi_ask` fails while `kimi_status` says Authenticated: Yes)

**Two resolvers, two stores.**

`kimi_ask` → `runKimiApi` → `loadApiAuth`. If no REST key, it hard-fails with the exact reported string (`src/kimi-api.ts:23-30`):

```ts
const auth = loadApiAuth()
if (!auth) {
  return { ok: false, text: '',
    error: 'Kimi Code API key not found. Set KIMICODE_API_KEY or add api_key to ~/.kimi-code/config.toml.' }
}
```

`loadApiAuth` only reads `KIMICODE_API_KEY` / `KIMI_BASE_URL` env or `api_key`/`base_url` in `config.toml` (`src/environment.ts:108-137`). It returns `null` unless an **API key** is present.

`kimi_code` does **not** use this. It spawns `kimi.exe` (CLI `runKimi`, or ACP `kimi acp`), which authenticates from the OAuth token file. `isAuthenticated` (`src/environment.ts:164-178`) checks `~/.kimi-code/credentials/kimi-code.json` for `access_token/refresh_token/id_token/token`:

```ts
return Boolean(data.access_token || data.refresh_token || data.id_token || data.token)
```

`kimi_status` reports both, from different sources (`src/index.ts:292` and `:299`):

```ts
`- Authenticated: ${status.authenticated ? 'Yes' : 'No'}`,   // = isAuthenticated() → OAuth token file
...
`- Configured: ${isApiConfigured() ? 'Yes' : 'No'}`,         // = loadApiAuth() !== null → REST key
```

So "Authenticated: Yes" (OAuth session is valid → `kimi_code` works) and "Kimi Code API Configured: No" (no REST key → `kimi_ask` cannot work) are **both accurate**, but the field naming makes them look contradictory. Root cause: `kimi_ask` is wired exclusively to the REST path and cannot borrow the OAuth session that `kimi_code` uses.

### Issue 2 — `action:status` returns the whole transcript

`src/index.ts:243-249`:

```ts
if (action === 'status') {
  if (task_id) {
    const task = taskStore.get(task_id)
    return textResponse(task ? JSON.stringify(task, null, 2) : `Task not found: ${task_id}`, !task)
  }
  return textResponse(JSON.stringify(taskStore.list(), null, 2))
}
```

`taskStore.get` / `taskStore.list` return full `TaskSnapshot`s, and `snapshot()` includes the entire accumulated log (`src/task-store.ts:185-199`):

```ts
output: task.output,                                   // up to MAX_TASK_OUTPUT_CHARS = 100_000
outputChunks: task.outputChunks.slice(-MAX_TASK_OUTPUT_CHUNKS),  // up to 1_000 chunks
```

Every progress event is appended to `output` during the run (background path: `appendReporter` → `taskStore.append`, `src/index.ts:96`, `:149`). A status check therefore drags back the full action log (hundreds of KB). There is no metadata-only branch.

### Issue 3 — `output` + `outputChunks` duplication

`append()` writes the same text into **both** fields (`src/task-store.ts:121-122`):

```ts
task.outputChunks.push(text)
task.output = task.output ? `${task.output}\n${text}` : text
```

`trimOutput` even rebuilds `output` from `outputChunks` (`:141`: `task.output = task.outputChunks.join('\n')`), confirming they are the same bytes in two shapes. The snapshot returns both, and `action:output` returns both explicitly (`src/index.ts:256`):

```ts
JSON.stringify({ id: task.id, status: task.status, output: task.output, outputChunks: task.outputChunks, error: task.error }, null, 2)
```

So a ~100k log becomes a ~200k payload.

### Issue 4 — Foreground 600s timeout hides progress / session

Timeout arming and resolution in `runKimi` (`src/kimi-runner.ts:258-266`):

```ts
let timer = setTimeout(() => {
  timedOut = true
  killProcessTree(proc.pid)
  timer = setTimeout(() => {
    finish({ ok: false, text: '', error: `Kimi timed out after ${Math.round(timeoutMs / 1000)}s` })
  }, KIMI_KILL_GRACE_MS)
}, timeoutMs)
```

and the close handler short-circuits on timeout (`:318-321`):

```ts
if (timedOut) {
  finish({ ok: false, text: '', error: `Kimi timed out after ${Math.round(timeoutMs / 1000)}s` })
  return
}
```

The **success** payload is the only one that carries the session id (`:337-340`):

```ts
const parsed = parseKimiStreamJson(stdout)
...
finish({ ok: true, text, thinking, sessionId: parsed.sessionId })
```

`sessionId` is parsed from stdout only at clean exit; the timeout path kills the tree and never parses, so even a known session id would be dropped. `index.ts` then returns a bare error with no session/resumable info (`src/index.ts:131-133`):

```ts
if (!result.ok) return textResponse(`Error: ${result.error}`, true)
const sessionLine = result.sessionId ? `\n\nSession: ${result.sessionId}` : ''
```

Hence the user sees `Error: Kimi timed out after 600s` with no `Session:` line and no hint that edits were written / session is resumable via `new_session:false`. (Note: default budget here is `timeout_ms ?? 600_000` from `index.ts:107/125`.)

### Issue 5 — ACP `session/prompt` timeout + repeated stall

The ACP default is **120s**, not 600s (`src/transports/acp.ts:14`):

```ts
const DEFAULT_ACP_TIMEOUT_MS = 120_000
```

`prompt()` issues the request with `this.timeoutMs` (`:328-335`):

```ts
prompt(sessionId: string | undefined, prompt: string, workDir?: string): Promise<unknown> {
  return this.request('session/prompt', { sessionId, cwd: workDir, prompt: [...], text: prompt }, this.timeoutMs)
}
```

`this.timeoutMs = clampTimeout(timeoutMs, DEFAULT_ACP_TIMEOUT_MS)` (`:248-250`), and the client is built from `options.timeoutMs` (`:596`). In `index.ts` the ACP path passes `timeoutMs: timeout_ms` straight through (`src/index.ts:143`) — which is `undefined` for `kimi_code` unless the caller sets `timeout_ms`, since (unlike the CLI path) there is **no `?? 600_000` default**. So an omitted `timeout_ms` collapses to 120s, producing `ACP request timed out: session/prompt` (`:284`) after ~2 min. This is the "hard internal limit not tied to timeout_ms" the report describes — it *is* tied to `timeout_ms`, but defaults much lower than CLI and lower than long agentic prompts need.

Stall detector (`src/progress.ts:325-356`, `DEFAULT_STALL_MS = 30_000` at `:3`) re-arms itself after every fire:

```ts
timer = setTimeout(() => {
  try { reporter(makeEvent('stall', `no activity for ${Math.round(stallMs / 1000)}s — Kimi may be stuck`)) }
  catch { /* ... */ }
  arm()   // <-- re-arms, so the message repeats every 30s
}, stallMs)
```

Pinged on each ACP notification (`src/transports/acp.ts:617` `watchdog?.ping()`); during a genuine silent window it emits the warning every 30s, bloating the background log.

### Issue 6 — CLI crash `0xC0000409` surfaced raw

`src/kimi-runner.ts:322-333`:

```ts
if (code !== 0) {
  const err = stderr.trim()
  const out = stdout.trim()
  let message: string
  if (err && out) {
    ...
    message = `kimi exited with code ${code}\nstderr: ${cappedErr}\nstdout: ${cappedOut}`
  } else {
    message = err || out || `kimi exited with code ${code}`
  }
  finish({ ok: false, text: '', error: message })
  return
}
```

A native fail-fast crash (`STATUS_STACK_BUFFER_OVERRUN`, decimal `3221226505` = `0xC0000409`) typically leaves stderr/stdout empty, so the `else` branch yields exactly `kimi exited with code 3221226505`. There is no hex translation, no "process crashed" classification, no "session may be recoverable" hint, and no dump. Exit codes are handled here but **crash codes are not distinguished** from ordinary non-zero exits.

### Issue 7 — `cancel` inconsistent (giant transcript vs clean JSON)

`src/index.ts:265-267`:

```ts
if (task_id) {
  const task = await taskStore.cancel(task_id)
  return textResponse(task ? JSON.stringify(task, null, 2) : `Task not found: ${task_id}`, !task)
}
```

`taskStore.cancel` returns a full snapshot (`src/task-store.ts:112` → `snapshot(task)`), which includes `output`+`outputChunks` (same as Issue 2/3). A task that had streamed a large log → giant payload (and trips the harness token limit); a task cancelled early with little output → small clean JSON. The behavior is deterministic in code but **data-dependent**, which reads as "inconsistent." The ACP-session cancel branch (`:269-271`) is small and stable by contrast.

### Issue 8 — Oversized result saved as one long-line JSON + "must read 100%" preamble

**This is harness behavior, not ladder-mcp.** There is no disk-write of results anywhere in `src/` (grep for `saved to` / `exceeds maximum` / `MUST read` returns only `acp.ts`'s unrelated "file exceeds maximum read size"). ladder-mcp returns its responses as `JSON.stringify(..., null, 2)` — already multi-line. The single-line file, the token-limit error, and the "you MUST read 100% of content" preamble are produced by the **MCP client (Claude Code)** when it intercepts an over-limit tool result, truncates it, and spills it to disk. The contributing cause owned by this repo is the oversized payload itself (Issues 2/3/7) — there is no server-side size guard to keep responses under the harness limit.

### Issue 9 — Recursive sub-agent / skill spawning + hang

No code constrains Kimi's internal delegation. The only injected control is a prose guard, and only on the CLI path (`src/kimi-runner.ts:52-60`):

```ts
const READ_ONLY_GUARD = '[READ-ONLY ANALYSIS MODE] Do not create, modify, or delete any files...'
export function applyReadOnlyGuard(prompt: string, edit: boolean | undefined): string {
  if (edit === true) return prompt
  return `${READ_ONLY_GUARD}\n\n${prompt}`
}
```

`buildKimiArgs` (`:38-50`) only ever passes `-p`, `--output-format stream-json`, and `-S`/`-C`; its comment notes `--plan/--auto/-y` are rejected in `-p` mode, so there is no hard flag to limit skills/sub-agents. Critically, the **ACP path sends the prompt verbatim** with no guard at all (`src/transports/acp.ts:328-335`, `src/index.ts:137-145` builds `runAcpPrompt({ prompt, ... })` directly from the raw `prompt`). Nothing sets delegation depth or disables `Skill subagent-driven-development`/`explore`, so Kimi is free to recurse and stall (compounding Issue 5).

### Issue 10 — Duplicate `tool_update` events

`src/transports/acp.ts:628-639`:

```ts
case 'tool_call':
case 'tool_call_update':
case 'plan': {
  const text = extractAcpText(update?.content) || JSON.stringify(update)
  ...
  const kind = updateType === 'tool_call' ? 'tool_call' : updateType === 'tool_call_update' ? 'tool_update' : 'plan'
  coalescer?.add(kind, text)
  break
}
```

`tool_call` (initial) and one or more `tool_call_update` (status changes) for the same tool carry the same `title`/prompt content; when `content` is empty the fallback `JSON.stringify(update)` is also near-identical. The coalescer forwards each action event immediately with **no de-duplication** (`src/progress.ts:283-294`), so the same long prompt is emitted twice in a row. In background mode every event is appended to the task log (`appendReporter`), making the duplication visible and doubling those lines (worsening Issues 2/3). Note also `AcpClient.dispatch` emits a `notification` for *every* message including `session/update` (`src/transports/acp.ts:412`), but the dedup gap is in the coalescer, not double-emission.

---

## Tool inventory (registered MCP tools)

Registered in `src/index.ts`. Server name `kimi-code` (`:27-30`).

Always registered:
- **`kimi_code`** (`:74`) — agentic work in a repo: analyze/edit files; CLI or ACP transport, foreground or background. Default transport ACP.
- **`kimi_ask`** (`:165`) — stateless question / independent review, text-only, no repo, no edits. **REST-API path only** (`runKimiApi`).
- **`kimi_sessions`** (`:193`) — list/inspect Kimi sessions from CLI catalog, ACP, or both.
- **`kimi_tasks`** (`:234`) — manage background work: `status` / `output` / `cancel`.
- **`kimi_status`** (`:277`) — installation, auth, diagnostics (basic/full).
- **`kimi_setup`** (`:330`) — generate the Kimi-hosted MCP config entry for Ladder_mcp.

Registered only when `process.env.LADDER_EXPERIMENTAL === '1'` (`:355`):
- **`kimi_export_session`** (`:356`) — export a Kimi session ZIP.
- **`kimi_visualize_session`** (`:376`) — preview/launch the localhost session visualizer.
- **`kimi_desktop_status`** (`:394`) — experimental read-only Desktop Work status probe.
- **`kimi_budget_probe`** (`:401`) — experimental guided budget-separation evidence workflow.

## Response-size guard

**There is no response-size / token-limit guard anywhere in ladder-mcp.** Every tool handler returns its payload via `textResponse(JSON.stringify(...))` with no length check before returning. The over-limit truncation, the on-disk spill, and the "you MUST read 100% of content" preamble are all imposed by the **MCP client (Claude Code)**, not this server.

The only size controls that exist are *internal budgets*, none of which cap the final MCP response:
- `maxChars(max_output_tokens)` → default `DEFAULT_MAX_OUTPUT_CHARS = 60_000` (`src/input-validation.ts:4,9-14`) — caps the Kimi answer text fed to `truncateAtBoundary`.
- Task store: `MAX_TASK_OUTPUT_CHARS = 100_000`, `MAX_TASK_OUTPUT_CHUNKS = 1_000`, `MAX_TASKS = 100` (`src/task-store.ts:3-5`) — trims the in-memory task buffer, but **both** `output` and `outputChunks` are returned, so the effective payload is ~2× (≈200k chars), which is exactly what tripped the harness limit (Issues 2/3/7).
- ACP: `MAX_ACP_METADATA_BYTES = 100 * 1024` caps assembled text and metadata (`src/transports/acp.ts:12`, `:668-675`); capture/frame caps at `:8/:10-13`.
- CLI capture: `MAX_CAPTURE_CHARS = 16 MiB`, failure streams capped at `MAX_FAILURE_STREAM_CHARS = 2_000` (`src/kimi-runner.ts:8-9`).

Net: the server can emit ~100–200k-char tool results with no guard, and relies on the client to deal with the overflow.

---

## Cross-cutting findings

1. **No server-side response budget.** Issues 2, 3, 7, 8 are one root problem: `kimi_tasks` serializes full task snapshots (and duplicates `output`/`outputChunks`) with no metadata-only mode and no size guard, so the harness truncates-and-spills. A single metadata-only `status` path + returning one of the two output fields fixes 2/3/7 and removes the trigger for 8.
2. **Two divergent auth models that the UI conflates.** OAuth session (`kimi_code`) vs REST key (`kimi_ask`); `kimi_status` reports both under similar-sounding labels (Issue 1).
3. **Timeout/error payloads are lossy.** Both the CLI timeout (Issue 4) and the CLI crash (Issue 6) discard recoverable context (`sessionId`, resumable flag, crash classification) that *is* available or derivable elsewhere in the same module.
4. **ACP defaults are mismatched to real workloads.** 120s prompt default (Issue 5) vs the CLI's 600s, plus a self-re-arming 30s stall logger and zero delegation control (Issue 9), make long ACP prompts both fail early and spam the log. Event de-dup is missing (Issue 10).
