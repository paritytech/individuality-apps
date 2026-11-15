// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A detached child leads its own process group; these wait for the whole group, vitest and its fork workers included, not just the npx wrapper. */
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** Resolves once no process is left in the group. After timeoutMs the group is sent SIGKILL and waited for again. */
export async function waitGroupGone(pgid: number, { timeoutMs = 15_000, pollMs = 50 }: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const until = Date.now() + timeoutMs
  while (groupAlive(pgid) && Date.now() < until) await sleep(pollMs)
  if (!groupAlive(pgid)) return
  try { process.kill(-pgid, "SIGKILL") } catch { /* gone meanwhile */ }
  while (groupAlive(pgid)) await sleep(pollMs)
}

/** Signal the whole group, then wait until it is gone. */
export async function terminateGroup(pgid: number, signal: NodeJS.Signals, options?: { timeoutMs?: number; pollMs?: number }): Promise<void> {
  try { process.kill(-pgid, signal) } catch { /* already gone */ }
  await waitGroupGone(pgid, options)
}
