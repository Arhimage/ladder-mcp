export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

const MAX_TASK_OUTPUT_CHARS = 100_000
const MAX_TASK_OUTPUT_CHUNKS = 1_000
const MAX_TASKS = 100
const CANCEL_HOOK_TIMEOUT_MS = 5_000

export interface TaskSnapshot {
  id: string
  kind: string
  status: TaskStatus
  createdAt: string
  startedAt?: string
  updatedAt: string
  finishedAt?: string
  output: string
  outputChunks: string[]
  error?: string
  metadata?: Record<string, unknown>
}

interface TaskRecord extends TaskSnapshot {
  controller: AbortController
  cancel?: () => void | Promise<void>
}

export class TaskStore {
  private nextId = 1
  private tasks = new Map<string, TaskRecord>()

  create(
    kind: string,
    executor: (signal: AbortSignal, append: (text: string) => void) => Promise<{ output?: string; metadata?: Record<string, unknown> }>,
    cancel?: () => void | Promise<void>,
  ): TaskSnapshot {
    const now = new Date().toISOString()
    const id = `task_${this.nextId++}`
    const controller = new AbortController()
    const task: TaskRecord = {
      id,
      kind,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      output: '',
      outputChunks: [],
      controller,
      cancel,
    }
    this.tasks.set(id, task)
    this.enforceRetention()

    queueMicrotask(async () => {
      if (controller.signal.aborted) return
      task.status = 'running'
      task.startedAt = new Date().toISOString()
      task.updatedAt = task.startedAt

      try {
        const result = await executor(controller.signal, (text) => this.append(id, text))
        if (controller.signal.aborted) return
        if (result.output) this.append(id, result.output)
        if (result.metadata) task.metadata = { ...(task.metadata ?? {}), ...result.metadata }
        task.status = 'succeeded'
        task.finishedAt = new Date().toISOString()
        task.updatedAt = task.finishedAt
      } catch (error) {
        if (controller.signal.aborted) return
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = new Date().toISOString()
        task.updatedAt = task.finishedAt
      }
    })

    return this.snapshot(task)
  }

  get(id: string): TaskSnapshot | undefined {
    const task = this.tasks.get(id)
    return task ? this.snapshot(task) : undefined
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()]
      .map((task) => this.snapshot(task))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async cancel(id: string): Promise<TaskSnapshot | undefined> {
    const task = this.tasks.get(id)
    if (!task) return undefined
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return this.snapshot(task)
    // Mark terminal up-front (synchronously, before the first await) so a concurrent
    // cancel(id) sees `cancelled` and returns via the guard above instead of running
    // the (possibly non-idempotent) cancel hook a second time on the same child.
    task.status = 'cancelled'
    task.finishedAt = new Date().toISOString()
    task.updatedAt = task.finishedAt
    task.controller.abort()
    if (task.cancel) {
      try {
        // Bound the cancel hook: a hook that never resolves must not block kimi_task_cancel
        // forever. The task is already marked cancelled, so on timeout we record a note and
        // return; the hook keeps running detached but no longer holds up the caller.
        await this.withTimeout(Promise.resolve(task.cancel()), CANCEL_HOOK_TIMEOUT_MS)
      } catch (error) {
        const cancelError = error instanceof Error ? error.message : String(error)
        task.error = task.error ? `${task.error}; cancel hook also failed: ${cancelError}` : cancelError
      }
    }
    return this.snapshot(task)
  }

  append(id: string, text: string): void {
    const task = this.tasks.get(id)
    if (!task || typeof text !== 'string' || text.length === 0) return
    // Late callbacks (e.g. a slow cancel hook or stray progress event) must not mutate
    // a task that has already reached a terminal state.
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return
    task.outputChunks.push(text)
    task.output = task.output ? `${task.output}\n${text}` : text
    this.trimOutput(task)
    task.updatedAt = new Date().toISOString()
  }

  // Record a truncation notice without clobbering a real error from the executor,
  // and without one truncation form masking the other (both can occur together).
  private noteTruncation(task: TaskRecord, message: string): void {
    if (task.error?.includes(message)) return
    task.error = task.error ? `${task.error}; ${message}` : message
  }

  private trimOutput(task: TaskRecord): void {
    if (task.outputChunks.length > MAX_TASK_OUTPUT_CHUNKS) {
      const excess = task.outputChunks.length - MAX_TASK_OUTPUT_CHUNKS
      task.outputChunks.splice(0, excess)
      this.noteTruncation(task, 'Task output chunk count exceeded the maximum and was truncated.')
    }

    task.output = task.outputChunks.join('\n')

    if (task.output.length <= MAX_TASK_OUTPUT_CHARS) return

    while (task.output.length > MAX_TASK_OUTPUT_CHARS && task.outputChunks.length > 1) {
      task.outputChunks.shift()
      task.output = task.outputChunks.join('\n')
    }

    if (task.outputChunks.length === 1 && task.outputChunks[0].length > MAX_TASK_OUTPUT_CHARS) {
      task.outputChunks[0] = task.outputChunks[0].slice(-MAX_TASK_OUTPUT_CHARS)
      task.output = task.outputChunks[0]
    }

    this.noteTruncation(task, 'Task output exceeded the maximum size and was truncated.')
  }

  private enforceRetention(): void {
    if (this.tasks.size <= MAX_TASKS) return
    const finished = [...this.tasks.values()]
      .filter((task) => ['succeeded', 'failed', 'cancelled'].includes(task.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const toRemove = Math.min(finished.length, this.tasks.size - MAX_TASKS)
    for (const task of finished.slice(0, toRemove)) {
      this.tasks.delete(task.id)
    }
    // Never evict a running/pending task to reclaim a slot: aborting and deleting an
    // in-flight job would silently kill someone else's work and leave it unqueryable
    // (`get()` returns undefined rather than a terminal `cancelled` snapshot). When
    // only running tasks remain, the map is allowed to exceed MAX_TASKS temporarily;
    // the overflow is bounded by the number of concurrently in-flight tasks and is
    // reclaimed as they finish and become eligible for eviction above.
  }

  private withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cancel hook timed out after ${ms}ms`)), ms)
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  private snapshot(task: TaskRecord): TaskSnapshot {
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
      output: task.output,
      outputChunks: task.outputChunks.slice(-MAX_TASK_OUTPUT_CHUNKS),
      error: task.error,
      metadata: task.metadata ? { ...task.metadata } : undefined,
    }
  }
}

export const taskStore = new TaskStore()
