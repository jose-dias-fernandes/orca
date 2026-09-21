const MAX_CONCURRENT = 4
let running = 0
type QueuedBusinessmapRequest = {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}
const queue: QueuedBusinessmapRequest[] = []

// Quota headers from the API: X-RateLimit-Remaining-Minute / -Hour.
let perMinuteRemaining: number | null = null
let throttledUntil = 0

function createBusinessmapRequestAbortError(): Error {
  const error = new Error('Businessmap request aborted')
  error.name = 'AbortError'
  return error
}

// Records quota state from response headers; called on every API response.
export function recordRateLimit(headers: Headers): void {
  const minuteValue = headers.get('x-ratelimit-remaining-minute')
  if (minuteValue !== null) {
    const parsed = Number(minuteValue)
    if (Number.isFinite(parsed)) {
      perMinuteRemaining = parsed
    }
  }
}

// Throttle gate: pause new reads when the minute quota is nearly spent.
function throttleDelayMs(): number {
  if (perMinuteRemaining !== null && perMinuteRemaining < 3) {
    return 5_000
  }
  const now = Date.now()
  return throttledUntil > now ? throttledUntil - now : 0
}

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createBusinessmapRequestAbortError())
  }
  const delay = throttleDelayMs()
  if (delay > 0) {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      cleanup()
      void acquire(signal).then(resolve, reject)
    }, delay)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(createBusinessmapRequestAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    return promise
  }
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const entry: QueuedBusinessmapRequest = {
    resolve,
    reject,
    signal,
    onAbort: () => {
      const index = queue.indexOf(entry)
      if (index === -1) {
        return
      }
      queue.splice(index, 1)
      reject(createBusinessmapRequestAbortError())
    }
  }
  signal?.addEventListener('abort', entry.onAbort, { once: true })
  queue.push(entry)
  return promise
}

export function release(): void {
  running -= 1
  let next = queue.shift()
  while (next) {
    next.signal?.removeEventListener('abort', next.onAbort)
    if (!next.signal?.aborted) {
      running += 1
      next.resolve()
      return
    }
    next.reject(createBusinessmapRequestAbortError())
    next = queue.shift()
  }
}

// Marks the minute quota exhausted after an RL02 rejection so new reads pause briefly.
export function noteRateLimitRejection(retryAfterSeconds: number | null): void {
  const waitMs = Math.max(1_000, (retryAfterSeconds ?? 5) * 1000)
  throttledUntil = Date.now() + waitMs
}
