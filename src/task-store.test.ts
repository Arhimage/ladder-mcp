import { describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('task-store', () => {
  it('tracks successful task output', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      append('chunk')
      return { output: 'done', metadata: { sessionId: 's1' } }
    })
    await delay(0)
    await delay(0)
    const snapshot = store.get(task.id)!
    expect(snapshot.status).toBe('succeeded')
    expect(snapshot.output).toContain('chunk')
    expect(snapshot.output).toContain('done')
    expect(snapshot.outputChunks).toEqual(['chunk', 'done'])
    expect(snapshot.outputLength).toBeGreaterThan(0)
    expect(snapshot.metadata).toEqual({ sessionId: 's1' })
  })

  it('create returns compact metadata without output body', () => {
    const store = new TaskStore()
    const task = store.create('test', async () => ({ output: 'done' }))

    expect(task.outputLength).toBe(0)
    expect('output' in task).toBe(false)
    expect('outputChunks' in task).toBe(false)
  })

  it('marks running tasks cancelled', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { output: 'should not append' }
    })
    await delay(0)
    const cancelled = await store.cancel(task.id)
    expect(cancelled?.status).toBe('cancelled')
  })

  it('cancel returns compact metadata without output body for terminal tasks', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      append('secret transcript')
      return { output: 'done' }
    })
    await delay(0)
    await delay(0)

    const cancelled = await store.cancel(task.id)

    expect(cancelled?.status).toBe('succeeded')
    expect('output' in cancelled!).toBe(false)
    expect('outputChunks' in cancelled!).toBe(false)
    expect(cancelled?.outputLength).toBeGreaterThan(0)
  })

  it('marks tasks cancelled even when cancel hook rejects', async () => {
    const store = new TaskStore()
    const task = store.create(
      'test',
      async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return {}
      },
      () => {
        throw new Error('cancel failed')
      },
    )
    await delay(0)
    const cancelled = await store.cancel(task.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.error).toBe('cancel failed')
  })

  it('evicts finished tasks before running tasks during retention', async () => {
    const store = new TaskStore()
    const running: string[] = []
    const finished: string[] = []
    for (let i = 0; i < 60; i++) {
      const task = store.create('test', async () => ({ output: 'done' }))
      finished.push(task.id)
    }
    await delay(0)
    for (let i = 0; i < 60; i++) {
      const task = store.create('test', async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return {}
      })
      running.push(task.id)
    }
    await delay(0)
    expect(store.list().length).toBeLessThanOrEqual(100)
    const latestRunning = running[running.length - 1]
    expect(store.get(latestRunning)).toBeDefined()
    expect(store.list().filter((t) => t.status === 'succeeded').length).toBeLessThan(finished.length)
  })

  it('does not block forever on a hanging cancel hook', async () => {
    vi.useFakeTimers()
    try {
      const store = new TaskStore()
      const task = store.create(
        'test',
        async (signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          return {}
        },
        () => new Promise<void>(() => {}), // never resolves
      )
      await vi.advanceTimersByTimeAsync(0)
      const cancelPromise = store.cancel(task.id)
      await vi.advanceTimersByTimeAsync(5_000)
      const cancelled = await cancelPromise
      expect(cancelled?.status).toBe('cancelled')
      expect(cancelled?.error).toMatch(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('limits output chunks and records truncation error', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      for (let i = 0; i < 1005; i++) append(String(i))
      return {}
    })
    await delay(0)
    await delay(0)
    const snapshot = store.get(task.id)!
    expect(snapshot.outputChunks.length).toBeLessThanOrEqual(1000)
    expect(snapshot.error).toMatch(/truncated/)
  })

  it('ignores late appends after a task reaches a terminal status', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      append('before')
      return { output: 'done' }
    })
    await delay(0)
    await delay(0)
    expect(store.get(task.id)!.status).toBe('succeeded')
    store.append(task.id, 'late')
    const snapshot = store.get(task.id)!
    expect(snapshot.output).not.toContain('late')
    expect(snapshot.outputChunks).toEqual(['before', 'done'])
  })

  it('status snapshot returns only metadata with outputLength', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      append('line one')
      append('line two')
      return {}
    })
    await delay(0)
    await delay(0)
    const status = store.status(task.id)!
    expect(status.outputLength).toBeGreaterThan(0)
    expect('output' in status).toBe(false)
  })

  it('output paginates in full mode', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      for (let i = 0; i < 5; i++) append(`line ${i}`)
      return {}
    })
    await delay(0)
    await delay(0)
    const slice = store.output(task.id, 'full', 1, 2)!
    expect(slice.lines).toEqual(['line 1', 'line 2'])
    expect(slice.offset).toBe(1)
    expect(slice.hasMore).toBe(true)
  })

  it('output final mode returns the trailing lines', async () => {
    const store = new TaskStore()
    const task = store.create('test', async (_signal, append) => {
      for (let i = 0; i < 5; i++) append(`line ${i}`)
      return {}
    })
    await delay(0)
    await delay(0)
    const slice = store.output(task.id, 'final', 0, 2)!
    expect(slice.lines).toEqual(['line 3', 'line 4'])
    expect(slice.hasMore).toBe(true)
  })

  it('truncates long errors in status snapshot', async () => {
    const store = new TaskStore()
    const longError = 'x'.repeat(2000)
    const task = store.create('test', async () => { throw new Error(longError) })
    await delay(0)
    await delay(0)
    const status = store.status(task.id)!
    expect(status.error).toContain('[error truncated]')
    expect(status.error!.length).toBeLessThan(longError.length)
  })

  it('uses random task ids', async () => {
    const store = new TaskStore()
    const t1 = store.create('test', async () => ({}))
    const t2 = store.create('test', async () => ({}))
    expect(t1.id).not.toBe(t2.id)
    expect(t1.id).toMatch(/^task_\d+_[a-z0-9]+$/)
  })
})
