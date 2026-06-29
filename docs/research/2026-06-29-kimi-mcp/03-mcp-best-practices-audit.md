# MCP Best-Practices Audit — ladder-mcp (kimi-code server)

**Date:** 2026-06-29
**Scope:** Audit of `src/index.ts`, `src/task-store.ts`, `src/types.ts` against the official Model Context Protocol specification and TypeScript SDK guidance. Source is READ-ONLY; no code was modified.
**Spec revision cited:** MCP **2025-06-18** (the revision whose URLs are quoted below). A newer revision (2025-11-25) exists; the tool-result / pagination / progress / cancellation / logging semantics quoted here are stable across both. Where I could not verify against the newest revision, it is flagged.

---

## 1. Best-Practices Checklist (with source URLs + spec revision)

### 1.1 Tool result design — structured vs unstructured content
- Tool results may carry **unstructured** content (`content[]` of `text`/`image`/`audio`/`resource_link`/`resource`) **and/or structured** content in a dedicated `structuredContent` field. ("Tool results may contain **structured** or **unstructured** content.")
- **Structured** content is "returned as a JSON object in the `structuredContent` field." For backwards compatibility a tool returning structured content **SHOULD also** serialize that JSON into a `TextContent` block.
- Tools **MAY** declare an **`outputSchema`** (JSON Schema). If present: servers **MUST** provide structured results conforming to it; clients **SHOULD** validate. Output schemas enable strict validation, type info, and better LLM parsing.
- Large / many results: a tool **MAY** return **Resource Links** (`type: "resource_link"`) or **embedded resources** rather than inlining everything, "to provide additional context or data … a URI that can be subscribed to or fetched by the client." SDK guidance: return `resource_link` items "without embedding content, letting clients fetch only what they need."
- Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools (rev 2025-06-18); SDK `registerTool`/`outputSchema`/`structuredContent`/`ResourceLink` examples: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md

### 1.2 Response size / token budget + pagination
- Pagination "allows servers to yield results in smaller chunks rather than all at once … useful for local integrations to avoid performance issues with large data sets."
- Model is **opaque cursor-based**, not numbered pages: the **cursor** is an opaque string token; **page size is determined by the server**; a response carries an optional **`nextCursor`** when more results exist; the client continues by sending `params.cursor`.
- Clients **MUST** treat cursors as opaque (don't parse/modify/persist). Invalid cursors **SHOULD** return `-32602`.
- Operations that support pagination: `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`. (Note: the spec's first-class pagination is for **list** RPCs; for an application-level "fetch a big blob" tool, the spec's size remedy is Resources / resource_link, plus an app-defined offset/limit cursor on the tool's own args.)
- Source: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination (rev 2025-06-18)

### 1.3 Error semantics — protocol error vs tool execution error
- **Two distinct mechanisms.** **Protocol Errors** = standard JSON-RPC `error` objects for "Unknown tools, Invalid arguments, Server errors" (e.g. `-32602` Invalid params, `-32603` Internal error). **Tool Execution Errors** = a normal `result` with **`isError: true`** for "API failures, Invalid input data, Business logic errors," with a human-readable `content[]` text describing the failure.
- Rule of thumb: the request itself failing to dispatch → JSON-RPC error; the tool ran but the *operation* failed → `result` with `isError:true` (so the LLM can see and react to it).
- Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling (rev 2025-06-18)

### 1.4 Tool naming, title, description, annotations, input schema
- A tool definition: `name` (unique id), optional **`title`** (human-readable display name), `description`, `inputSchema` (JSON Schema), optional `outputSchema`, optional **`annotations`**.
- Annotations (behavior hints): **`readOnlyHint`**, **`destructiveHint`**, **`idempotentHint`**, **`openWorldHint`**, plus a display `title`. Clients **MUST** treat annotations as untrusted unless from a trusted server. Annotations are hints, not security guarantees.
- Servers **MUST** validate all tool inputs and sanitize outputs.
- Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools (rev 2025-06-18)

### 1.5 Progress notifications + cancellation
- **Progress:** for long-running ops the caller includes a `_meta.progressToken` (string|int, unique across active requests); the server sends `notifications/progress` with `progressToken`, a monotonically increasing `progress`, optional `total`, and a human-readable `message`. Notifications **MUST** stop after completion; both sides **SHOULD** rate-limit.
  Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress
- **Cancellation:** sender emits `notifications/cancelled` with `requestId` + optional `reason`; receiver **SHOULD** stop processing, free resources, and not send a response; both sides **MUST** handle the race where cancellation arrives after completion. Both **SHOULD** log the reason.
  Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation

### 1.6 Logging vs returning data
- Servers send diagnostic/progress chatter via `notifications/message` (the `logging` capability), with RFC 5424 levels (`debug`…`emergency`); clients set verbosity via `logging/setLevel`. Log notifications are the channel for "operation progress updates" / debug traces — **not** the tool's return value.
- Implication: a tool's `result` should carry the *answer/outcome*, while step-by-step execution trace belongs in `notifications/message` (or `notifications/progress`), not stuffed into the result payload.
- Logs **MUST NOT** contain secrets/PII; servers **SHOULD** rate-limit.
- Source: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging (rev 2025-06-18)

---

## 2. Audit Table

Compliance: ✅ compliant · ⚠️ partial · ❌ violation

| Tool | Best practice | Compliant? | Violation detail (file:line) |
|------|---------------|:--:|------------------------------|
| **kimi_tasks** (`status`) | 1.2 keep status cheap / metadata-only; no full body by default | ❌ | `status` returns the **entire** task snapshot via `JSON.stringify(task, null, 2)` — including the full `output` string **and** `outputChunks[]` — even for a liveness check. `src/index.ts:244-248`; snapshot built at `src/task-store.ts:185-199`. This is the 200k-char dump in report issue #2. |
| **kimi_tasks** (`output`) | 1.1 structured/large data → structuredContent/resource_link; 1.2 pagination | ❌ | Returns `{ output, outputChunks, … }` as one JSON text blob with **no `offset`/`limit`/cursor**, **no `final` vs `full` split**. `src/index.ts:251-259`. Whole transcript every call. |
| **kimi_tasks** (`output`) | 1.2 no data duplication | ❌ | Payload ships **both** `output` (joined string) and `outputChunks` (same chunks) — doubles an already-over-limit body. `src/index.ts:256`; duplication originates in `TaskSnapshot` (`src/task-store.ts:16-17`) and `snapshot()` (`:194-195`). Report issue #3. |
| **kimi_tasks** (`cancel`) | 1.3 deterministic, compact error/ack shape | ❌ | `cancel` of a task returns the full `snapshot(task)` (huge `output`/`outputChunks`) — `src/index.ts:266`/`task-store.ts:112` — while session-cancel returns a small `{ok,…}` (`:271`) and arg-validation returns bare strings (`:263,273`). Three different shapes ⇒ report issue #7 (sometimes giant transcript, sometimes clean JSON). |
| **kimi_tasks** (all) | 1.1 outputSchema/structuredContent | ❌ | No `outputSchema`; results are `JSON.stringify` into a `text` block (`src/index.ts:61-63`). Clients can't validate; LLM must re-parse JSON from text. |
| **kimi_tasks** (all) | 1.4 title + annotations (`readOnlyHint` for status/output) | ❌ | No `title`, no `annotations`. `status`/`output` are read-only and should set `readOnlyHint:true`; `cancel` is a state change. `src/index.ts:234-241`. |
| **kimi_tasks** | 1.6 log/trace ≠ return value | ❌ | The accumulating action transcript (tool_calls, stalls, dup prompts) is the *return value* of `status`/`output` instead of being a log/progress stream; the result should carry the final answer + metadata. Root of issues #2, #8, #10. |
| **kimi_code** (foreground ACP) | 1.1/1.3 clean result, not raw object dump | ❌ | ACP path returns `JSON.stringify(result, null, 2)` (the raw `KimiResult`) as text — `src/index.ts:161` — whereas the CLI path returns a clean text answer (`:133`). Inconsistent result shape across transports. |
| **kimi_code** (background) | 1.1 structuredContent/outputSchema | ❌ | Background returns the task object as `JSON.stringify(task,null,2)` text (`src/index.ts:116, 157`); no structured field. |
| **kimi_code** (timeout/error) | 1.3 useful error payload | ❌ | Timeout/failure returns bare `` `Error: ${result.error}` `` (`src/index.ts:131`) — no `session_id`, no `resumable:true`, no affected-files, despite edits being on disk and the session resumable. Report issue #4. Error is an unstructured string, not a structured error payload. |
| **kimi_code** | 1.4 annotations — destructive when `edit:true` | ⚠️/❌ | No `annotations`. A repo-editing tool should declare `destructiveHint:true` (and `openWorldHint:true`); analysis-only could advertise `readOnlyHint`. `src/index.ts:74-90`. Input schema itself is rich and well-described (good). |
| **kimi_code** | 1.5 progress notifications | ✅ | Foreground uses `createMcpProgressReporter(extra)` → emits `notifications/progress` (`src/index.ts:128,160`). Honors `extra.signal` for cancellation (`:129`). This part follows the spec. |
| **kimi_code** | 1.4 `title` | ❌ | No human-readable `title` (only `name`+description). Applies to every tool. |
| **kimi_ask** | 1.3 error semantics | ✅ | Uses `result`+`isError:true` for execution failure (`src/index.ts:183,188`) — correct mechanism (though payload is a plain string, see 1.1). |
| **kimi_ask** | 1.1 outputSchema; 1.4 `readOnlyHint`/title | ⚠️ | Returns clean text (good for a chat answer) but no `title`, no `readOnlyHint:true` for a stateless read-only tool. `src/index.ts:165-191`. |
| **kimi_sessions** | 1.2 cursor pagination / nextCursor | ❌ | A **list** operation that paginates with a custom `limit` int and **no cursor / no `nextCursor`** (`src/index.ts:193-231`). Spec mandates opaque cursor-based pagination for list ops; results are dumped as one JSON text blob with no continuation token. |
| **kimi_sessions** | 1.1 structuredContent | ❌ | `JSON.stringify(sessions,null,2)` into text; no `structuredContent`/`outputSchema`. `src/index.ts:207,230`. |
| **kimi_status** | 1.1/1.3 | ⚠️ | Human-readable markdown is fine, and `isError` reflects `status.error`/subcall failure (`src/index.ts:326`) — reasonable. But large `full` mode inlines capabilities/doctor/providers as `JSON.stringify` text (`:313-323`); no `structuredContent`, no `title`/`readOnlyHint`. |
| **kimi_setup** | 1.1/1.4 | ⚠️ | Returns `JSON.stringify(result,null,2)` text (`src/index.ts:351`); no `structuredContent`/`outputSchema`, no `title`. Low impact. |
| **All tools** | 1.4 `title` + `annotations` | ❌ | No tool declares `title` or any annotation (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`). Grep across `server.tool(` registrations in `src/index.ts`. |
| **All tools** | 1.1 outputSchema/structuredContent | ❌ | The single helper `textResponse()` (`src/index.ts:61-63`) is the only result builder; every structured payload is serialized into a `text` block. No tool sets `structuredContent` or `outputSchema`. |
| **Server** | capability hygiene | ⚠️ | `McpServer` declares no `logging` capability and the code emits no `notifications/message`; all diagnostics travel as result bodies or progress. (`src/index.ts:27-30`.) Adopting logging would let the transcript leave the result payload. |

---

## 3. Prioritized Violations Driving the Reported Bugs

Ordered by user pain / blast radius (maps to report `kimi-mcp-issues-2026-06-29.md`).

1. **`kimi_tasks status` returns the whole transcript instead of metadata** — *Best practice 1.2 / 1.6.*
   `src/index.ts:244-248` serializes the full `TaskSnapshot` (incl. `output` + `outputChunks`). A liveness check should return only `id, status, kind, startedAt/finishedAt, updatedAt, error, outputLength`. **Biggest driver — report #2 (BLOCKER).** Fix: metadata-only `status`; never return the body by default.

2. **`output` + `outputChunks` duplication in the task object** — *Best practice 1.2 (no duplication).*
   `src/task-store.ts:16-17,194-195` → surfaced at `src/index.ts:256`. Doubles an already-oversized payload. **Report #3 (MAJOR).** Fix: return one representation; expose chunks only on explicit request.

3. **No structured-data path: everything `JSON.stringify`'d into one text blob; no pagination; no `final` vs `full` split** — *Best practice 1.1 + 1.2.*
   `output` action (`src/index.ts:251-259`) has no `offset`/`limit`/cursor and no `structuredContent`/`outputSchema`/`resource_link`. This is why a 200k-char single-line JSON gets dumped and saved as one unreadable line (**report #2, #8**). Fix: `final`/`full` modes + `offset`/`limit`, or return oversized output as a `resource_link` the client fetches on demand.

4. **Timeout/error payload is an unstructured string with no resumability info** — *Best practice 1.3.*
   `src/index.ts:131` returns `` `Error: ${result.error}` `` with no `session_id`, `resumable:true`, or affected files, even though edits persisted and the session resumes via `new_session:false`. **Report #4 (MAJOR).** Fix: structured error object (`isError:true` + `structuredContent` carrying `session_id`, `resumable`, `partial`).

5. **`cancel` returns inconsistent/oversized shapes** — *Best practice 1.3 (deterministic compact ack).*
   `src/index.ts:262-274` returns a full task snapshot for task-cancel (can be huge), a compact object for session-cancel, and bare strings for validation. **Report #7 (MINOR but confusing).** Fix: always return a small deterministic `{ id, status, finishedAt, error? }` ack; never the body.

6. **Missing `title` + behavior annotations on every tool (notably `kimi_code` destructive when `edit:true`)** — *Best practice 1.4.*
   No `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` anywhere (`server.tool(...)` blocks in `src/index.ts`). A file-editing tool advertising no `destructiveHint`, and read-only `status`/`output`/`kimi_ask`/`kimi_status` advertising no `readOnlyHint`, deprive clients of the human-in-the-loop signal the spec calls for. Fix: add `title` + annotations to each registration.

**Secondary / structural:** `kimi_sessions` ignores MCP cursor pagination (custom `limit`, no `nextCursor`) — `src/index.ts:193-231` (1.2); `kimi_code` ACP foreground dumps the raw `KimiResult` object as text while the CLI path returns clean text (1.1, `src/index.ts:161` vs `:133`); no `logging` capability so execution traces have nowhere to go but the result body (1.6).

---

### Sources
- Tools (rev 2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Pagination: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination
- Progress: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress
- Cancellation: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
- Logging: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging
- TypeScript SDK (registerTool / outputSchema / structuredContent / ResourceLink): https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md

**Unverified / caveats:** Quoted revision is **2025-06-18**; a newer **2025-11-25** revision exists (https://modelcontextprotocol.io/specification/2025-11-25/schema) — the tool-result, pagination, progress, cancellation, and logging semantics used here are unchanged across both, but the newest page text was not re-fetched line-by-line. The SDK `outputSchema`/`structuredContent`/`ResourceLink` snippets were retrieved via web search of the official SDK `docs/server.md`, not by reading the repo file directly.
