// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A READ THAT RIDES THROUGH A BRIEF OUTAGE. The journey's own chain reader (chain-read.mts watch) polls the chain every 6 s for
// minutes; the chain-outage profile cuts the People RPC for 10 s in the middle of that, and a poll that throws would end the
// watch and fail the bot for the profile's own doing. A failed read is retried every `waitMs`, up to `tries` times in a row, and
// the last error is thrown only when the chain stays unreachable for all of them. Pure; vitest pins it (read-retry.test.ts).
export async function retryRead<T>(read: () => Promise<T>, o: { tries: number; waitMs: number; sleep?: (ms: number) => Promise<void>; onRetry?: (error: unknown, attempt: number) => void }): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (attempt >= o.tries) throw error
      o.onRetry?.(error, attempt)
      await sleep(o.waitMs)
    }
  }
}
