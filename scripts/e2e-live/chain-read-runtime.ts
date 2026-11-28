// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const CHAIN_READ_MARGIN_MS = 10_000
export const CHAIN_READ_PARENT_TIMEOUT_MS = {
  default: 120_000,
  votes: 600_000,
} as const

export function chainReadChildTimeoutMs(command: string): number | null {
  if (command === "watch") return null
  const parent = command === "votes" ? CHAIN_READ_PARENT_TIMEOUT_MS.votes : CHAIN_READ_PARENT_TIMEOUT_MS.default
  return parent - CHAIN_READ_MARGIN_MS
}

export function chainReadExitError(command: string, code: number | null, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(`chain-read ${command} exited ${code}${detail ? `: ${detail}` : ""}`)
}

export async function withChainReadTimeout<T>(
  work: Promise<T>,
  options: { command: string; endpoint: string; timeoutMs: number },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `chain-read "${options.command}" timed out after ${options.timeoutMs / 1000} s against ${options.endpoint}`,
        ),
      )
    }, options.timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface PollCheck {
  name: string
  status: string
  detail: string
}

const boundedDetail = (detail: string) => (detail.length <= 120 ? detail : `${detail.slice(0, 117)}...`)

export function formatSignUpPoll(attempt: number, elapsedMs: number, checks: PollCheck[]): string {
  const passed = checks.filter((check) => check.status === "pass").length
  const failures = checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.name}: ${boundedDetail(check.detail)}`)
  return `sign-up poll ${attempt} (${Math.round(elapsedMs / 1000)} s): ${passed}/${checks.length} registered${failures.length ? `; ${failures.join("; ")}` : ""}`
}

export function medianObservedBlockMs(samples: readonly number[]): number | null {
  const usable = samples.filter((sample) => Number.isFinite(sample) && sample > 0).sort((a, b) => a - b)
  if (!usable.length) return null
  const middle = Math.floor(usable.length / 2)
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2
}
