// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReadTimeoutError, retryRead } from "./read-retry"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const never = () => new Promise<never>(() => {})

describe("read retry works", () => {
  it("aborts a timed-out attempt before starting the next one", async () => {
    const signals: AbortSignal[] = []
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? never() : Promise.resolve("chest")
    })

    const result = retryRead(read, { attemptMs: 15_000, delaysMs: [1_000] })
    await vi.advanceTimersByTimeAsync(16_000)

    await expect(result).resolves.toBe("chest")
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
  })

  it("asks again when an attempt never answers, and returns the answer of a later attempt", async () => {
    // Given
    const answers = [never(), Promise.resolve("chest")]
    const read = vi.fn(() => answers.shift() ?? never())
    const onRetry = vi.fn()

    // When
    const result = retryRead(read, { onRetry, attemptMs: 15_000, delaysMs: [1_000] })
    await vi.advanceTimersByTimeAsync(16_000)

    // Then
    await expect(result).resolves.toBe("chest")
    expect(read).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.any(ReadTimeoutError), 1, 1_000)
  })

  it("asks again after a read that fails, without waiting for the deadline", async () => {
    // Given
    const read = vi.fn().mockRejectedValueOnce(new Error("storage query failed")).mockResolvedValue("chest")

    // When
    const result = retryRead(read, { attemptMs: 15_000, delaysMs: [1_000] })
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    await expect(result).resolves.toBe("chest")
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("hands each retry the wait the caller asked for before it", async () => {
    // Given
    const failure = new Error("storage query failed")
    const read = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue("chest")
    const onRetry = vi.fn()

    // When
    const result = retryRead(read, { onRetry, attemptMs: 15_000, delaysMs: [5, 7] })
    await vi.advanceTimersByTimeAsync(12)

    // Then
    await expect(result).resolves.toBe("chest")
    expect(onRetry.mock.calls).toEqual([
      [failure, 1, 5],
      [failure, 2, 7],
    ])
  })

  it("returns a read that answers null at once, rather than taking it for the deadline", async () => {
    // Given
    const read = vi.fn(async () => null)

    // When
    const result = await retryRead(read, { attemptMs: 15_000, delaysMs: [1_000] })

    // Then
    expect(result).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe("read retry fails", () => {
  it("aborts the active attempt and files no retry when its caller leaves", async () => {
    const controller = new AbortController()
    let attempt: AbortSignal | undefined
    const read = vi.fn((signal: AbortSignal) => {
      attempt = signal
      return never()
    })
    const result = retryRead(read, { signal: controller.signal, delaysMs: [1_000] })
    await vi.advanceTimersByTimeAsync(0)

    controller.abort(new Error("superseded"))

    await expect(result).rejects.toThrow("superseded")
    expect(attempt?.aborted).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("rejects with the last failure once every retry has run out", async () => {
    // Given
    const read = vi.fn(never)

    // When
    const result = retryRead(read, { attemptMs: 15_000, delaysMs: [1_000, 3_000] })
    const rejection = expect(result).rejects.toBeInstanceOf(ReadTimeoutError)
    await vi.advanceTimersByTimeAsync(15_000 + 1_000 + 15_000 + 3_000 + 15_000)

    // Then
    await rejection
    expect(read).toHaveBeenCalledTimes(3)
  })
})
