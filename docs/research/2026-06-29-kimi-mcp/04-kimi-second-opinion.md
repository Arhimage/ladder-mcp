# WS2 — Независимый второй взгляд от Kimi (kimi-code 0.20.1)

> Получено прямым запуском `kimi -p` (foreground, не через MCP, не в фоне), `--skills-dir <empty>` для отключения авто-скиллов. Kimi читал только исходники, ничего не менял. Сессия: `kimi -r session_cc6edcbe-4d35-40b0-80b3-e9c1aa06839e`.
>
> Ниже — дословный аналитический вывод Kimi (reasoning-шум отрезан). Совпадает с WS1 по корневым причинам — это повышает уверенность.

Ниже — независимый разбор по реальному коду `src/`. Изменений не вносил, файлы не создавал.

---

## 1. Сводная таблица: причины и фиксы

| # | Проблема | file:line | Корневая причина | Предложение по фиксу |
|---|----------|-----------|------------------|----------------------|
| 1 | `kimi_ask` падает без ключа при «Authenticated: Yes» | `src/kimi-api.ts:18-29` `src/environment.ts:210-243` `src/index.ts:286-300` | Два независимых канала аутентификации. `kimi_ask` требует `loadApiAuth()` (API-key + base_url), а `kimi_status` показывает `isAuthenticated()` (наличие `credentials/kimi-code.json`). Статус смешивает их в одну строку «Authenticated: Yes», создавая ложное ожидание. | В `kimi_status` разделить строки: «CLI/ACP authenticated» и «Kimi Code API configured». В ошибке `kimi_ask` явно написать, что `kimi_code` работает без API-ключа. Для `kimi_ask` без ключа возвращать понятную диагностику ещё до сетевого запроса. |
| 2 | `kimi_tasks` возвращает весь транскрипт | `src/task-store.ts:185-199` `src/index.ts:243-248` `src/index.ts:251-260` | `snapshot()` отдаёт `output` + `outputChunks` целиком. `action=status` сериализует весь объект. `output` — склейка всех `formatTaskLogLine` событий (tool_call, stall, plan, todo), то есть сырой накопительный лог. | `status` должен возвращать только метаданные: `id`, `kind`, `status`, timestamps, `error`, `outputLength`. Для тела — `action=output` с `mode=final\|full` и `offset`/`limit`. |
| 3 | Дублирование `output` + `outputChunks` | `src/task-store.ts:115-125` `src/task-store.ts:185-199` | `append()` пушит чанк в массив и пересобирает строку `output`; `snapshot()` возвращает и то, и другое, удваивая payload. | Хранить только `outputChunks`. `output` формировать на лету или не отдавать. `outputChunks` — только по `include_chunks=true`. |
| 4 | Foreground `kimi_code` таймаутит на 600с и скрывает прогресс | `src/index.ts:119-134` `src/kimi-runner.ts:258-266` `src/kimi-runner.ts:316-333` `src/kimi-runner.ts:119-148` | При `setTimeout` процесс убивается, `runKimi` возвращает `Error: Kimi timed out after 600s`, не разбирая stdout/stderr. `sessionId`/`resume_hint` не извлекаются. | В обработчике таймаута перед `finish` парсить накопленный stdout/stderr через `parseKimiStreamJson`/`extractResumeHint`, возвращать `sessionId` и `resumable:true`. В `index.ts` форматировать ошибку таймаута с подсказкой `session_id` / `new_session:false`. |
| 5 | ACP: `session/prompt` timed out + повторяющиеся `stall` | `src/transports/acp.ts:248-254` `src/transports/acp.ts:276-292` `src/transports/acp.ts:328-335` `src/index.ts:136-162` `src/progress.ts:325-356` | `AcpClient` по умолчанию 120с (`DEFAULT_ACP_TIMEOUT_MS`), CLI-путь — 600с. `runAcpPrompt` не получает `timeout_ms ?? 600_000`, поэтому без явного таймаута ACP рвётся через ~2 мин. `createStallWatchdog` каждые 30с шлёт `stall`, даже когда Kimi просто думает. | В `index.ts` передавать `timeoutMs: timeout_ms ?? 600_000` в `runAcpPrompt`. Параметр `acp_prompt_timeout`. В watchdog не перезапускать `stall` бесконечно либо повышать порог для длинных задач. |
| 6 | CLI падает с `0xC0000409` | `src/kimi-runner.ts:316-333` | `runKimi` обрабатывает любой ненулевой код одинаково: `kimi exited with code ${code}`. Windows fail-fast не распознаётся, stderr пуст, дамп не логируется. | Распознавать известные коды (`0xC0000409`, `0xC0000005`), возвращать «CLI crashed (code …), session may be recoverable». Логировать stderr/stdout, искать `.dmp`/WER. |
| 7 | `action:cancel` непоследователен | `src/index.ts:265-267` `src/task-store.ts:90-113` `src/task-store.ts:185-199` | `cancel()` возвращает `snapshot(task)` с `output`/`outputChunks`. Накопился лог — ответ огромен; нет — мал. | `cancel` возвращает компактный статус без тела. |
| 8 | Файл результата — одна сверхдлинная строка JSON | `src/index.ts:243-248` `src/index.ts:251-260` `src/task-store.ts:115-125` | Ответ — JSON с `output` одной строкой, содержащей `\n`. Харнесс сохраняет как есть → чтение по строкам невозможно. | Разделить метаданные и тело; тело массивом строк (`outputLines`) или отдельным файлом. `action=output` с `offset`/`limit`. |
| 9 | Рекурсивный sub-agent + зависание | `src/index.ts:57-59` `src/index.ts:136-162` `src/transports/acp.ts:594-689` | Сервер не ограничивает skills/subagents в ACP. Плотный `wrapPrompt()` + `AI_CONSUMER_NOTICE` побуждают Kimi к делегированию. | Параметр `disable_skills` / `max_subagent_depth`, передавать в system prompt запрет на subagents для аналитики. |
| 10 | Дублирующиеся `tool_update` | `src/transports/acp.ts:620-640` `src/progress.ts:283-294` | ACP шлёт и `tool_call`, и `tool_call_update` для одного действия; оба пишутся в лог без дедупликации по `toolCallId`. | Дедуплицировать по `toolCallId`/`title`; не логировать `tool_call_update`, дублирующий недавний `tool_call`. |

---

## 2. MCP vs ACP: нужен ли MCP-сервер (позиция Kimi)

**Краткий ответ:** обёртка оправдана, но текущая реализация часто добавляет проблем. MCP стоит сохранить как **тонкий адаптер**, а не «логгер-в-логгер» с двойным хранением вывода.

**Что MCP даёт поверх прямого ACP:**
- Стандартный интерфейс `tools` со схемами (zod), progress-нотификации и abort-signal вместо ручного JSON-RPC lifecycle ACP.
- Управление фоновыми задачами (`kimi_tasks`) — клиент может вернуться к долгой работе.
- Абстракция транспорта `cli` ↔ `acp` (на Windows CLI заметно стабильнее — абстракция реально спасает).
- Валидация `work_dir`, read-only guard, sandbox путей (`src/input-validation.ts`, `src/transports/acp.ts:496-544`).
- Единая точка входа: `kimi_sessions`, `kimi_status`, `kimi_setup`, `kimi_export_session`.

**Где MCP не оправдан сейчас:** двойная аутентификация (п.1); накопление raw transcript (пп.2,3,8,10); несогласованные таймауты (п.5).

**Вывод:** сохранить MCP, но сделать тонким — убрать накопление raw transcript, `kimi_tasks` отдаёт метаданные + paginated output, унифицировать таймауты/статусы, разделить CLI-auth и API-key auth, для продвинутых сценариев оставить «прямой ACP».

---

## 3. Что мог упустить разбор по симптомам (системные находки Kimi)

- **События `stall` — синтетика** (`src/progress.ts:325-356`), не приходят от Kimi. 30с — эвристика; на тяжёлом reasoning неизбежны и не означают зависания.
- **`output` обрезается с начала** (`src/task-store.ts:134-156`): даже `full` transcript не покажет начало задачи.
- **Task store in-memory** (`src/task-store.ts:27-29`): перезапуск сервера убивает все фоновые задачи и их логи.
- **Read-only guard — только prompt** (`src/kimi-runner.ts:52-60`): жёсткого CLI-флага нет, модель может проигнорировать.
- **`api_key` в `config.toml` может содержать `${VAR}`** (`interpolateEnv`, `src/environment.ts:99-101`): незаданная переменная → пустой ключ → `isApiConfigured()` false. Этого вида диагностики в статусе нет.
- **Обрезку делает MCP-хост**, не `ladder-mcp` («result exceeds maximum allowed tokens»). Сервер не знает лимита контекста хоста → компактный ответ по умолчанию — единственный надёжный путь.
- **ACP `session/prompt` может иметь внутренний таймаут в самом `kimi.exe`**, не контролируемый обёрткой → нужны heartbeat/keepalive или документированный лимит.
