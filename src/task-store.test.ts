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
    expect(snapshot.metadata).toEqual({ sessionId: 's1' })
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
})
